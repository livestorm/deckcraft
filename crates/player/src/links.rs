//! The links a viewer can click on the slide shown: hyperlinks on shapes and pictures
//! (`a:hlinkClick` on `cNvPr`) and on runs of text, one box per line a run is laid out on.
//!
//! Boxes come from [`deckcraft_render::place_slide`] and the choice of what a click lands on from
//! [`ShowState::top`] and [`ShowState::target`], as in the desktop slide show: the topmost shape
//! shown decides, a shape without an action blocks what lies beneath it, a group's action covers
//! its children, and a text hyperlink applies when its shape is the one on top. Only what is shown
//! at the current position counts: a shape not yet animated in, or gone, can't be clicked.
//!
//! Targets are filtered for a browser: web, mail and phone links only, and slides of the show.

use std::collections::HashMap;

use deckcraft_anim::{AnimState, HitShape, ShowState, safe_url};
use deckcraft_geom::Point;
use deckcraft_model::text::{Action, Hyperlink};
use deckcraft_model::{Presentation, Shape, ShapeId, ShapeKind};
use deckcraft_render::{PlacedLink, PlacedShape};

use crate::{Player, Pos};

/// At most this many link regions per slide position.
pub const MAX_LINKS: usize = 256;
/// Longer URLs are refused.
pub const MAX_URL_LEN: usize = 2048;
/// Labels are cut to this many characters.
pub const MAX_LABEL_CHARS: usize = 200;

/// Where a link goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkTarget {
    /// A web page (`http`, `https`), an e-mail address (`mailto`) or a phone number (`tel`).
    Url(String),
    /// A slide of the show: its index in the presentation (what [`Pos::slide`] holds) and its id
    /// in the file ([`crate::SlideInfo::file_id`]).
    Slide {
        index: usize,
        file_id: Option<u32>,
    },
    NextSlide,
    PreviousSlide,
    FirstSlide,
    LastSlide,
    EndShow,
}

/// A link on the slide shown, for a host to put an accessible anchor over it.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkRegion {
    pub target: LinkTarget,
    /// The shape the link is on (for a text link, the shape holding the text).
    pub shape: ShapeId,
    /// A link on text rather than on the whole shape.
    pub text: bool,
    /// The box's corners as fractions of the slide's width and height, rotation and flips
    /// included: top left, top right, bottom right, bottom left of the unrotated box.
    pub quad: [[f64; 2]; 4],
    /// The box bounding `quad`: `[x, y, w, h]`, fractions of the slide.
    pub rect: [f64; 4],
    /// The link's ScreenTip, if it has one.
    pub tooltip: String,
    /// What the link is on: the linked text, else the shape's alternative text or its text.
    pub label: String,
}

/// The slide's shapes and links as laid out, kept while the show stays on the slide.
pub(crate) struct Placement {
    slide: usize,
    shapes: Vec<PlacedShape>,
    links: Vec<PlacedLink>,
}

/// A region with the index in [`Placement::shapes`] of the shape it is on.
struct Found {
    region: LinkRegion,
    owner: usize,
}

impl Player {
    /// The links a viewer can click at the current position, back to front (a link drawn over
    /// another comes after it). At most [`MAX_LINKS`].
    pub fn links(&mut self) -> Vec<LinkRegion> {
        self.found().map(|(found, ..)| found.into_iter().map(|f| f.region).collect()).unwrap_or_default()
    }

    /// The link a click at (`x`, `y`) follows, in fractions of the slide's width and height:
    /// `None` when a click there is not on a link. Always one of [`Player::links`].
    pub fn link_at(&mut self, x: f64, y: f64) -> Option<LinkRegion> {
        if !(x.is_finite() && y.is_finite()) {
            return None;
        }
        let pos = self.pos;
        let (found, states, quads) = self.found()?;
        let size = self.pres.slide_size;
        let p = Point::new(x * size.width, y * size.height);
        let placement = self.placement.as_ref()?;
        let tl = self.timelines.get(pos.slide)?;
        let hits: Vec<HitShape> = placement
            .shapes
            .iter()
            .zip(&quads)
            .map(|(s, q)| HitShape {
                id: s.id,
                parent: s.parent,
                is_group: s.is_group,
                link: s.link.as_ref().map(|l| l.action.clone()),
                under_pointer: inside(q, p),
            })
            .collect();
        let shown: HashMap<ShapeId, bool> = placement.shapes.iter().zip(&states).map(|(s, a)| (s.id, seen(a))).collect();
        let visible = |id: ShapeId| shown.get(&id).copied().unwrap_or(false);
        let show = show_state(pos);
        let top = show.top(&self.pres, tl, &hits, &visible);
        // A text link applies when its shape, or a group it is in, is the one on top.
        let on_top = |owner: usize| {
            let mut at = top;
            (0..=hits.len()).any(|_| match at.and_then(|k| hits.get(k).map(|h| (k, h))) {
                Some((k, _)) if k == owner => true,
                Some((_, h)) => {
                    at = h.parent;
                    false
                }
                None => false,
            })
        };
        let size = (size.width.max(1.0), size.height.max(1.0));
        let text = found.iter().rev().find(|f| f.region.text && on_top(f.owner) && inside(&to_slide(&f.region.quad, size), p));
        if let Some(f) = text {
            return Some(f.region.clone());
        }
        let target = show.target(&self.pres, tl, &hits, &visible)?;
        target.link.as_ref()?;
        found.into_iter().find(|f| !f.region.text && f.region.shape == target.shape).map(|f| f.region)
    }

    /// The regions at the current position, with each shape's animation state and corners as
    /// shown (slide points). `None` when the slide can't be laid out.
    fn found(&mut self) -> Option<(Vec<Found>, Vec<AnimState>, Vec<[Point; 4]>)> {
        let pos = self.pos;
        if self.placement.as_ref().is_none_or(|p| p.slide != pos.slide) {
            let placed = deckcraft_render::place_slide(&self.pres, pos.slide);
            self.placement = Some(Placement { slide: pos.slide, shapes: placed.shapes, links: placed.links });
        }
        let placement = self.placement.as_ref()?;
        let tl = self.timelines.get(pos.slide)?;
        let slide = self.pres.slides.get(pos.slide)?;
        let size = (self.pres.slide_size.width.max(1.0), self.pres.slide_size.height.max(1.0));
        let animated = !self.pres.show.without_animation;
        let states: Vec<AnimState> =
            placement.shapes.iter().map(|s| if animated { tl.state(s.id, None, pos.step, 0.0) } else { AnimState::default() }).collect();
        let quads: Vec<[Point; 4]> = placement.shapes.iter().zip(&states).map(|(s, a)| moved(s.quad, s.rect.center(), a)).collect();
        // A shape is shown when it and the groups around it are.
        let shown = |mut i: usize| {
            for _ in 0..=placement.shapes.len() {
                let (Some(s), Some(a)) = (placement.shapes.get(i), states.get(i)) else { return false };
                if !seen(a) {
                    return false;
                }
                match s.parent {
                    Some(p) => i = p,
                    None => return true,
                }
            }
            false
        };
        let index: HashMap<ShapeId, usize> = placement.shapes.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
        let mut found: Vec<Found> = Vec::new();
        let region = |link: &Hyperlink, owner: usize, quad: [Point; 4], text: bool, label: String| -> Option<Found> {
            let s = placement.shapes.get(owner)?;
            let target = target(&self.pres, &self.order, &link.action)?;
            let quad = to_unit(&quad, size)?;
            Some(Found {
                region: LinkRegion { target, shape: s.id, text, rect: bounds(&quad), quad, tooltip: cut([link.tooltip.as_str()]), label },
                owner,
            })
        };
        for (i, s) in placement.shapes.iter().enumerate() {
            if found.len() >= MAX_LINKS {
                break;
            }
            if !shown(i) {
                continue;
            }
            if let (Some(link), Some(q)) = (&s.link, quads.get(i))
                && let Some(f) = region(link, i, *q, false, find_shape(&slide.shapes, s.id, 0).map(shape_label).unwrap_or_default())
            {
                found.push(f);
            }
        }
        for l in placement.links.iter().filter(|l| l.text) {
            if found.len() >= MAX_LINKS {
                break;
            }
            // Text on the slide itself: links in the layout's and master's graphics aren't followed.
            let Some(&owner) = index.get(&l.shape) else { continue };
            if !shown(owner) {
                continue;
            }
            if let Some(para) = l.para
                && animated
                && tl.paragraph_targets(l.shape).contains(&para)
                && !seen(&tl.state(l.shape, Some(para), pos.step, 0.0))
            {
                continue;
            }
            let (Some(s), Some(a)) = (placement.shapes.get(owner), states.get(owner)) else { continue };
            let label = find_shape(&slide.shapes, l.shape, 0).zip(l.para).map(|(m, p)| linked_text(m, p, &l.link)).unwrap_or_default();
            if let Some(f) = region(&l.link, owner, moved(l.quad, s.rect.center(), a), true, label) {
                found.push(f);
            }
        }
        // Back to front: by shape, a shape's own link under its text links.
        found.sort_by_key(|f| (f.owner, f.region.text));
        Some((found, states, quads))
    }
}

fn show_state(pos: Pos) -> ShowState {
    let mut s = ShowState::default();
    s.slide = pos.slide;
    s.step = pos.step;
    s
}

fn seen(a: &AnimState) -> bool {
    a.visible && a.opacity > 0.0
}

/// Where a link goes, or `None` for one the browser player doesn't follow: a URL that is not
/// web, mail or phone, a slide that is not in the show (missing from the file, or hidden: the
/// show can't go on from a hidden slide), the last slide viewed, custom shows, programs and media.
pub(crate) fn target(pres: &Presentation, order: &[usize], action: &Action) -> Option<LinkTarget> {
    Some(match action {
        Action::Url { url } => LinkTarget::Url(allowed_url(url)?),
        Action::Slide { slide } => {
            let index = pres.slides.iter().position(|s| s.id == *slide)?;
            if !order.contains(&index) {
                return None;
            }
            LinkTarget::Slide { index, file_id: pres.slides.get(index).and_then(|s| s.file_id) }
        }
        Action::NextSlide => LinkTarget::NextSlide,
        Action::PreviousSlide => LinkTarget::PreviousSlide,
        Action::FirstSlide => LinkTarget::FirstSlide,
        Action::LastSlide => LinkTarget::LastSlide,
        Action::EndShow => LinkTarget::EndShow,
        Action::LastViewed | Action::CustomShow { .. } | Action::Program { .. } | Action::PlayMedia => return None,
    })
}

/// `url` trimmed, if a browser may open it from a deck: `http` and `https` with a host, `mailto`
/// (as the desktop show, [`safe_url`]) and `tel`. No spaces, control characters, `javascript:`,
/// `data:`, `file:` or relative paths, and at most [`MAX_URL_LEN`] bytes.
pub(crate) fn allowed_url(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() || u.len() > MAX_URL_LEN || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (scheme, rest) = u.split_once(':')?;
    let ok = match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" => {
            let host = rest.strip_prefix("//").unwrap_or("").split(['/', '?', '#']).next().unwrap_or("");
            safe_url(u) && !host.is_empty() && !host.starts_with('@') && !host.starts_with(':')
        }
        "mailto" => safe_url(u),
        "tel" => !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || "+-.()*#;=,/%".contains(c)),
        _ => false,
    };
    ok.then(|| u.to_string())
}

/// `quad` (slide points) moved as the shape's animation state at rest moves it: offset, then
/// scaled and turned about the box's centre, as the desktop show's hit test undoes it.
fn moved(quad: [Point; 4], center: Point, a: &AnimState) -> [Point; 4] {
    if a.offset_x == 0.0 && a.offset_y == 0.0 && a.scale_x == 1.0 && a.scale_y == 1.0 && a.rotate == 0.0 {
        return quad;
    }
    let (sin, cos) = a.rotate.to_radians().sin_cos();
    quad.map(|p| {
        let (x, y) = ((p.x - center.x) * a.scale_x, (p.y - center.y) * a.scale_y);
        Point::new(center.x + a.offset_x + x * cos - y * sin, center.y + a.offset_y + x * sin + y * cos)
    })
}

/// Is `p` inside the convex quadrilateral `q` (edges included)? A box of no area holds nothing.
fn inside(q: &[Point; 4], p: Point) -> bool {
    let cross = |a: Point, b: Point, c: Point| (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    let area = cross(q[0], q[1], q[2]) + cross(q[0], q[2], q[3]);
    if !area.is_finite() || area.abs() < 1e-9 {
        return false;
    }
    (0..4).all(|i| {
        let (a, b) = (q[i], q[(i + 1) % 4]);
        cross(a, b, p) * area.signum() >= -1e-9
    })
}

fn to_unit(q: &[Point; 4], (w, h): (f64, f64)) -> Option<[[f64; 2]; 4]> {
    let out = q.map(|p| [p.x / w, p.y / h]);
    out.iter().flatten().all(|v| v.is_finite()).then_some(out)
}

fn to_slide(q: &[[f64; 2]; 4], (w, h): (f64, f64)) -> [Point; 4] {
    q.map(|[x, y]| Point::new(x * w, y * h))
}

fn bounds(q: &[[f64; 2]; 4]) -> [f64; 4] {
    let xs = q.map(|p| p[0]);
    let ys = q.map(|p| p[1]);
    let (x0, x1) = (xs.iter().copied().fold(f64::INFINITY, f64::min), xs.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    let (y0, y1) = (ys.iter().copied().fold(f64::INFINITY, f64::min), ys.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    [x0, y0, x1 - x0, y1 - y0]
}

fn find_shape(shapes: &[Shape], id: ShapeId, depth: usize) -> Option<&Shape> {
    if depth > 32 {
        return None;
    }
    shapes.iter().find_map(|s| {
        if s.id == id {
            return Some(s);
        }
        match &s.kind {
            ShapeKind::Group { children, .. } => find_shape(children, id, depth + 1),
            _ => None,
        }
    })
}

/// The shape's alternative text, else its title, else its text.
fn shape_label(s: &Shape) -> String {
    if let Some(t) = [&s.descr, &s.title].into_iter().find(|t| !t.trim().is_empty()) {
        return cut([t.as_str()]);
    }
    let paras = s.text.as_ref().map_or(&[][..], |b| b.paragraphs.as_slice());
    cut(paras.iter().flat_map(|p| p.runs.iter().map(|r| r.text.as_str()).chain([" "])))
}

/// The text of paragraph `para` of `s` that carries `link`.
fn linked_text(s: &Shape, para: usize, link: &Hyperlink) -> String {
    let Some(p) = s.text.as_ref().and_then(|b| b.paragraphs.get(para)) else { return String::new() };
    cut(p.runs.iter().filter(|r| r.props.link.as_ref() == Some(link)).map(|r| r.text.as_str()))
}

/// The pieces joined, whitespace runs as single spaces, trimmed, cut to [`MAX_LABEL_CHARS`]
/// characters: never more is copied, however long the text.
fn cut<'a>(pieces: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    let mut n = 0;
    let mut space = false;
    for c in pieces.into_iter().flat_map(str::chars) {
        if n >= MAX_LABEL_CHARS {
            break;
        }
        if c.is_whitespace() || c.is_control() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            n += 1;
            space = false;
            if n >= MAX_LABEL_CHARS {
                break;
            }
        }
        out.push(c);
        n += 1;
    }
    out
}
