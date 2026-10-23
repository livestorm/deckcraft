//! DeckCraft player: a `.pptx` slide show without the editor, for embedding.
//!
//! - [`Player::open`]: read a deck (and its embedded fonts) once.
//! - A show position is a [`Pos`]: a slide and how many of its main steps are done. Two players
//!   given the same position draw the same picture, whatever path led there, so a presenter can
//!   share the position alone and every viewer renders it locally.
//! - [`Player::jump`] shows a position at rest; [`Player::advance`] plays the animation from the
//!   current position to the next one (a click step, or the next slide's transition and its
//!   automatic first step).
//! - [`Player::frame`] returns the picture at a moment of the show as straight RGBA, and the media
//!   effects (Play, Pause, Stop) the show reached, for the host page to carry out.
//!
//! Embedded audio and video are not played here: [`Player::media`] hands their bytes and boxes to
//! the host, whose own players have sound.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]
#![forbid(unsafe_code)]

use std::sync::Arc;

use deckcraft_anim::{Source, Timeline, show_order, transition_frame, uses_slide_parts};
use deckcraft_fonts::FontDb;
use deckcraft_model::{Presentation, Shape, ShapeId, ShapeKind};
use deckcraft_render::{
    Image, ParaState, PathMorph, RenderOpts, ShapeState, SlideParts, TextMorph, composite_transition, render_blend, render_slide,
};

#[cfg(test)]
mod tests;

/// Largest frame width rendered, whatever the host asks for.
pub const MAX_WIDTH: u32 = 1920;

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("the presentation is password-protected")]
    Encrypted,
    #[error("not a PowerPoint presentation")]
    NotPptx,
    #[error("the presentation could not be read: {0}")]
    Unreadable(String),
    #[error("the presentation has no slides to show")]
    Empty,
}

/// A place in the show: slide `slide` (index into the presentation) with `step` main steps done.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Pos {
    pub slide: usize,
    pub step: usize,
}

/// What the host needs to know about one slide of the show.
#[derive(Clone, Debug, PartialEq)]
pub struct SlideInfo {
    /// Index into the presentation (what [`Pos::slide`] holds).
    pub index: usize,
    pub title: String,
    pub notes: String,
    /// Main steps: clicks, plus an automatic first step when the first effect starts by itself.
    pub steps: usize,
    /// The first step plays by itself when the slide appears.
    pub auto_first: bool,
}

/// One embedded audio or video clip, for the host to play over the slide.
#[derive(Clone, Debug)]
pub struct MediaClip {
    pub slide: usize,
    pub shape: ShapeId,
    pub video: bool,
    pub content_type: String,
    /// Embedded bytes (empty for linked media).
    pub data: Arc<Vec<u8>>,
    /// External link instead of embedded bytes.
    pub link: Option<String>,
    /// Box on the slide as fractions of the slide's width and height: `[x, y, w, h]`.
    pub rect: [f64; 4],
    pub volume: f64,
    pub trim_start_ms: u32,
    pub trim_end_ms: u32,
}

/// A media effect the show reached: `action` is `play`, `pause` or `stop`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cue {
    pub shape: ShapeId,
    pub action: String,
}

/// A rendered picture: straight RGBA8, `width` × `height`.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// One layer of a transition frame for a GPU: triangles over a texture slot (or a solid colour).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeshLayer {
    /// Slot in [`TransitionFrame::textures`]; `None` draws `color`.
    pub texture: Option<usize>,
    pub color: [f32; 3],
    /// `x, y, u, v, alpha` per vertex; positions in slide units (0..1, y down).
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
}

/// A transition frame as layers for the host to draw, instead of a composited picture.
#[derive(Clone, Debug, Default)]
pub struct TransitionFrame {
    /// The transition's pictures, handed out on its first frame only (then `None`), by
    /// [`MeshLayer::texture`] slot: the old slide, the new slide, then the old background and
    /// contents and the new background and contents (for transitions that move contents over
    /// backgrounds).
    pub textures: Option<Vec<Option<Frame>>>,
    pub layers: Vec<MeshLayer>,
}

/// What [`Player::frame`] produced.
#[derive(Clone, Debug, Default)]
pub struct Tick {
    /// A new picture; `None` when the last one is still right.
    pub frame: Option<Frame>,
    /// With [`Player::set_gpu_transitions`], a transition frame to draw from layers.
    pub transition: Option<TransitionFrame>,
    pub cues: Vec<Cue>,
    /// Something is still moving: call again on the next animation frame.
    pub animating: bool,
}

#[derive(Clone, Debug)]
struct StepRun {
    /// The main step playing.
    step: usize,
    start: f64,
    duration: f64,
    /// Seconds into the step already scanned for media cues.
    cued: f64,
}

#[derive(Clone, Debug)]
struct TransitionRun {
    from: Option<usize>,
    kind: String,
    option: String,
    start: f64,
    duration: f64,
    old: Option<Image>,
    new: Image,
    parts: Option<SlideParts>,
    /// The new slide's automatic first step plays once the transition ends.
    then_auto: bool,
    /// The pictures were handed to the host (GPU transitions).
    textures_sent: bool,
}

pub struct Player {
    pres: Presentation,
    order: Vec<usize>,
    timelines: Vec<Timeline>,
    pos: Pos,
    width: u32,
    height: u32,
    step: Option<StepRun>,
    transition: Option<TransitionRun>,
    /// Position and size of the last picture handed out at rest.
    shown: Option<(Pos, u32, u32)>,
    warnings: Vec<String>,
    gpu_transitions: bool,
}

impl Player {
    /// Read a `.pptx` / `.ppsx` and install the fonts it embeds. Starts at the first slide, at
    /// rest, 1280 px wide.
    pub fn open(bytes: &[u8]) -> Result<Player, OpenError> {
        if !deckcraft_pptx::sniff(bytes) {
            return Err(if deckcraft_pptx::is_encrypted(bytes) { OpenError::Encrypted } else { OpenError::NotPptx });
        }
        let (mut pres, lost) = deckcraft_pptx::import_checked(bytes).map_err(|e| OpenError::Unreadable(e.to_string()))?;
        deckcraft_format::repair(&mut pres);
        install_embedded_fonts(&pres);
        let order = show_order(&pres);
        let Some(&first) = order.first() else { return Err(OpenError::Empty) };
        let timelines = pres.slides.iter().map(|s| Timeline::new(s, pres.slide_size.width, pres.slide_size.height)).collect();
        let warnings = lost.into_iter().map(|part| format!("slide {part} could not be read and is left out")).collect();
        let mut player = Player {
            pres,
            order,
            timelines,
            pos: Pos::default(),
            width: 0,
            height: 0,
            step: None,
            transition: None,
            shown: None,
            warnings,
            gpu_transitions: false,
        };
        player.resize(1280);
        player.pos = player.entry(first);
        Ok(player)
    }

    /// Add a font (TTF, OTF or TTC) for text to be drawn in, e.g. a stand-in for an Office font.
    /// Returns the number of faces added.
    pub fn add_font(bytes: Vec<u8>) -> usize {
        FontDb::global().add_font(bytes)
    }

    /// Add a font file under the family name a document uses (a [`FontRequest`]'s `family`), so
    /// text in that family draws with it. Returns the faces added.
    pub fn add_font_as(bytes: Vec<u8>, family: &str) -> usize {
        FontDb::global().add_font_as(bytes, family)
    }

    /// The fonts this deck needs and the machine lacks, for the host to fetch: each style of each
    /// missing family (with the families to try for it), and a face for each script the Latin
    /// fonts don't draw. Fonts the deck embeds are already installed and asked for nothing.
    pub fn font_requests(&self) -> Vec<FontRequest> {
        requests_for(&deckcraft_model::fonts::used_fonts(&self.pres), |f| FontDb::global().has_family(f))
    }

    /// Hand transition frames out as layers ([`Tick::transition`]) for the host to draw on a GPU,
    /// rather than compositing them on the CPU. Morph is always rendered here.
    pub fn set_gpu_transitions(&mut self, on: bool) {
        self.gpu_transitions = on;
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Slide width / height.
    pub fn aspect(&self) -> f64 {
        let s = self.pres.slide_size;
        if s.width > 0.0 && s.height > 0.0 { s.width / s.height } else { 16.0 / 9.0 }
    }

    /// The slides of the show, in show order (hidden slides left out).
    pub fn slides(&self) -> Vec<SlideInfo> {
        self.order
            .iter()
            .filter_map(|&i| {
                let slide = self.pres.slides.get(i)?;
                Some(SlideInfo { index: i, title: slide.title(), notes: slide.notes_text(), steps: self.steps(i), auto_first: self.auto_first(i) })
            })
            .collect()
    }

    pub fn position(&self) -> Pos {
        self.pos
    }

    pub fn animating(&self) -> bool {
        self.step.is_some() || self.transition.is_some()
    }

    /// Render `width` px wide (capped at [`MAX_WIDTH`]), height from the slide's aspect.
    pub fn resize(&mut self, width: u32) {
        let w = width.clamp(16, MAX_WIDTH);
        let h = ((w as f64) / self.aspect()).round().max(1.0) as u32;
        if (w, h) != (self.width, self.height) {
            self.width = w;
            self.height = h;
            self.shown = None;
            self.transition = None;
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Where a click goes from `pos`: the next step, else the next slide (with its automatic
    /// first step done). `None` at the end of the show.
    pub fn next_of(&self, pos: Pos) -> Option<Pos> {
        if pos.step < self.steps(pos.slide) {
            return Some(Pos { slide: pos.slide, step: pos.step + 1 });
        }
        let k = self.order.iter().position(|&i| i == pos.slide)?;
        self.order.get(k + 1).map(|&i| self.entry(i))
    }

    /// Where Back goes from `pos`: undo the last click step, else the previous slide fully
    /// built. An automatic first step is part of the slide appearing and is never undone.
    pub fn prev_of(&self, pos: Pos) -> Option<Pos> {
        let floor = usize::from(self.auto_first(pos.slide));
        if pos.step > floor {
            return Some(Pos { slide: pos.slide, step: pos.step - 1 });
        }
        let k = self.order.iter().position(|&i| i == pos.slide)?;
        let i = *self.order.get(k.checked_sub(1)?)?;
        Some(Pos { slide: i, step: self.steps(i) })
    }

    /// The position a slide is entered at: its automatic first step done.
    pub fn entry(&self, slide: usize) -> Pos {
        Pos { slide, step: usize::from(self.auto_first(slide)) }
    }

    /// Show `pos` at rest, without playing anything: for jumps, Back, and late joiners.
    pub fn jump(&mut self, pos: Pos) {
        let pos = self.clamp(pos);
        self.step = None;
        self.transition = None;
        self.pos = pos;
    }

    /// Go to `target`, playing the animation when it is exactly one click ahead of the current
    /// position ([`Player::next_of`]); anything else is a [`Player::jump`]. `now` is in seconds,
    /// on the clock later passed to [`Player::frame`].
    pub fn advance(&mut self, target: Pos, now: f64) {
        let target = self.clamp(target);
        // Finish what is playing first, so a fast presenter never leaves a client behind.
        self.settle();
        if self.next_of(self.pos) != Some(target) {
            self.jump(target);
            return;
        }
        if target.slide == self.pos.slide {
            self.start_step(self.pos.step, now);
            self.pos = target;
            return;
        }
        let from = self.pos.slide;
        self.pos = target;
        self.start_transition(Some(from), target, now);
    }

    /// The picture at `now`, and the media cues reached since the last call.
    pub fn frame(&mut self, now: f64) -> Tick {
        let mut cues = Vec::new();
        if let Some(tr) = &self.transition {
            let p = progress(now, tr.start, tr.duration);
            if p < 1.0 {
                if self.gpu_transitions && tr.kind != "morph" {
                    let transition = self.transition_layers(p);
                    return Tick { transition: Some(transition), cues, animating: true, ..Default::default() };
                }
                let frame = self.transition_frame(p);
                return Tick { frame: Some(frame), cues, animating: true, ..Default::default() };
            }
            let then_auto = tr.then_auto;
            self.transition = None;
            if then_auto {
                self.start_step(0, now);
            }
        }
        if let Some(run) = self.step.clone() {
            let t = (now - run.start).max(0.0);
            cues = self.cues(self.pos.slide, run.step, run.cued, t.min(run.duration));
            if t < run.duration {
                if let Some(r) = self.step.as_mut() {
                    r.cued = t;
                }
                let img = self.render(self.pos.slide, run.step, t);
                return Tick { frame: Some(to_frame(&img)), cues, animating: true, ..Default::default() };
            }
            self.step = None;
        }
        if self.shown == Some((self.pos, self.width, self.height)) {
            return Tick { frame: None, cues, animating: false, ..Default::default() };
        }
        self.shown = Some((self.pos, self.width, self.height));
        let img = self.render(self.pos.slide, self.pos.step, 0.0);
        Tick { frame: Some(to_frame(&img)), cues, animating: false, ..Default::default() }
    }

    /// Every audio and video clip of the show's slides.
    pub fn media(&self) -> Vec<MediaClip> {
        let size = self.pres.slide_size;
        let (sw, sh) = (size.width.max(1.0), size.height.max(1.0));
        let mut out = Vec::new();
        for &i in &self.order {
            let Some(slide) = self.pres.slides.get(i) else { continue };
            let placed = deckcraft_render::place_slide(&self.pres, i);
            let mut clips = Vec::new();
            collect_clips(&slide.shapes, &mut clips);
            for (id, clip) in clips {
                let Some(item) = self.pres.media(clip.media) else { continue };
                let Some(r) = placed.shapes.iter().find(|p| p.id == id).map(|p| p.rect) else { continue };
                out.push(MediaClip {
                    slide: i,
                    shape: id,
                    video: clip.video,
                    content_type: item.content_type.clone(),
                    data: item.data.clone(),
                    link: item.link.clone(),
                    rect: [r.x0 / sw, r.y0 / sh, r.width() / sw, r.height() / sh],
                    volume: clip.volume,
                    trim_start_ms: clip.trim_start_ms,
                    trim_end_ms: clip.trim_end_ms,
                });
            }
        }
        out
    }

    fn steps(&self, slide: usize) -> usize {
        if self.pres.show.without_animation { 0 } else { self.timelines.get(slide).map(Timeline::steps).unwrap_or(0) }
    }

    fn auto_first(&self, slide: usize) -> bool {
        !self.pres.show.without_animation && self.timelines.get(slide).is_some_and(|t| t.steps() > 0 && t.step_is_auto(0))
    }

    fn clamp(&self, pos: Pos) -> Pos {
        let slide = if pos.slide < self.pres.slides.len() { pos.slide } else { self.order.first().copied().unwrap_or(0) };
        Pos { slide, step: pos.step.min(self.steps(slide)) }
    }

    /// End whatever is playing: the position already holds where it ends.
    fn settle(&mut self) {
        self.step = None;
        self.transition = None;
    }

    fn start_step(&mut self, step: usize, now: f64) {
        let duration = self.timelines.get(self.pos.slide).map(|t| t.step_duration(step)).unwrap_or(0.0);
        self.step = Some(StepRun { step, start: now, duration, cued: f64::NEG_INFINITY });
    }

    fn start_transition(&mut self, from: Option<usize>, target: Pos, now: f64) {
        let then_auto = target.step > 0 && self.auto_first(target.slide);
        let (kind, option, duration) = self
            .pres
            .slides
            .get(target.slide)
            .and_then(|s| s.transition.as_ref())
            .map(|t| (t.kind.clone(), t.option.clone(), t.duration_ms as f64 / 1000.0))
            .unwrap_or_else(|| ("none".into(), String::new(), 0.0));
        if kind == "none" || duration <= 0.0 || self.pres.show.without_animation {
            if then_auto {
                self.start_step(0, now);
            }
            return;
        }
        let old = from.map(|i| {
            let steps = self.steps(i);
            self.render(i, steps, 0.0)
        });
        let new = self.render(target.slide, 0, 0.0);
        let parts = if uses_slide_parts(&kind, &option) {
            let scale = self.scale();
            let opts = RenderOpts { scale, size: Some((self.width, self.height)), ..Default::default() };
            Some(SlideParts::render(&self.pres, from, target.slide, &opts))
        } else {
            None
        };
        self.transition = Some(TransitionRun { from, kind, option, start: now, duration, old, new, parts, then_auto, textures_sent: false });
    }

    fn transition_frame(&self, p: f64) -> Frame {
        let Some(tr) = &self.transition else { return Frame::default() };
        if tr.kind == "morph"
            && let Some(from) = tr.from
            && let Some(img) = self.morph(from, p)
        {
            return to_frame(&img);
        }
        let layers = transition_frame(&tr.kind, &tr.option, p, self.aspect());
        to_frame(&composite_transition(tr.old.as_ref(), &tr.new, tr.parts.as_ref(), &layers))
    }

    /// The layers of the transition at progress `p`, and its pictures on the first call.
    fn transition_layers(&mut self, p: f64) -> TransitionFrame {
        let aspect = self.aspect();
        let Some(tr) = self.transition.as_mut() else { return TransitionFrame::default() };
        let parts = tr.parts.as_ref();
        let has = |slot: usize| match slot {
            0 => tr.old.is_some(),
            1 => true,
            2 => parts.is_some_and(|p| p.old_back.is_some()),
            3 => parts.is_some_and(|p| p.old_content.is_some()),
            _ => parts.is_some(),
        };
        let mut layers = Vec::new();
        for l in transition_frame(&tr.kind, &tr.option, p, aspect) {
            const BLACK: [f32; 3] = [0.0, 0.0, 0.0];
            let (texture, color) = match l.source {
                Source::Old => (has(0).then_some(0), BLACK),
                Source::New => (Some(1), BLACK),
                Source::Black => (None, BLACK),
                Source::White => (None, [1.0, 1.0, 1.0]),
                Source::OldBack => (if has(2) { Some(2) } else { has(0).then_some(0) }, BLACK),
                Source::NewBack => (Some(if has(4) { 4 } else { 1 }), BLACK),
                Source::OldContent if has(3) => (Some(3), BLACK),
                Source::NewContent if has(5) => (Some(5), BLACK),
                Source::OldContent | Source::NewContent => continue,
            };
            let (verts, tris) = deckcraft_anim::layer_mesh(&l);
            let vertices = verts
                .iter()
                .flat_map(|v| {
                    let a = if v.a.is_finite() { v.a.clamp(0.0, 1.0) } else { 0.0 };
                    [v.pos[0] as f32, v.pos[1] as f32, v.uv[0] as f32, v.uv[1] as f32, a as f32]
                })
                .collect();
            layers.push(MeshLayer { texture, color, vertices, indices: tris.into_iter().flatten().collect() });
        }
        let textures = (!tr.textures_sent).then(|| {
            tr.textures_sent = true;
            let parts = tr.parts.as_ref();
            vec![
                tr.old.as_ref().map(to_frame),
                Some(to_frame(&tr.new)),
                parts.and_then(|p| p.old_back.as_ref()).map(to_frame),
                parts.and_then(|p| p.old_content.as_ref()).map(to_frame),
                parts.map(|p| to_frame(&p.new_back)),
                parts.map(|p| to_frame(&p.new_content)),
            ]
        });
        TransitionFrame { textures, layers }
    }

    fn morph(&self, from: usize, p: f64) -> Option<Image> {
        let to = self.pos.slide;
        let a = self.pres.slides.get(from)?;
        let b = self.pres.slides.get(to)?;
        let tl = self.timelines.get(to)?;
        let hidden_b = |id: ShapeId| {
            let st = state_for(tl, id, 0, 0.0);
            !st.visible || st.opacity <= 0.0
        };
        let m = deckcraft_anim::morph_frame(&self.pres, a, b, p, &hidden_b);
        let f = |id: ShapeId| ShapeState { opacity: m.opacity_of(id), ..Default::default() };
        let opts = RenderOpts { scale: self.scale(), size: Some((self.width, self.height)), state: Some(&f), ..Default::default() };
        let text: Vec<TextMorph> =
            m.text.iter().map(|x| TextMorph { old: x.old, new: x.new, from: x.from, to: x.to, chars: x.chars, t: m.mix }).collect();
        let paths: Vec<PathMorph> =
            m.paths.iter().map(|x| PathMorph { id: x.id, from: x.from.clone(), from_box: x.from_box, to_box: x.to_box, t: m.mix }).collect();
        Some(render_blend(&self.pres, from, to, m.mix, &m.shapes, &text, &paths, &opts))
    }

    fn scale(&self) -> f64 {
        self.width as f64 / self.pres.slide_size.width.max(1.0)
    }

    /// Slide `slide` with `step` main steps done and the next one `t` seconds in. Video clips are
    /// left out: the host plays them over the picture.
    fn render(&self, slide: usize, step: usize, t: f64) -> Image {
        let Some(tl) = self.timelines.get(slide) else { return Image::default() };
        let mut clips = Vec::new();
        if let Some(s) = self.pres.slides.get(slide) {
            collect_clips(&s.shapes, &mut clips);
        }
        let hidden: Vec<ShapeId> = clips.into_iter().filter(|(_, c)| c.video).map(|(id, _)| id).collect();
        let f = |id: ShapeId| {
            let mut st = state_for(tl, id, step, t);
            if hidden.contains(&id) {
                st.visible = false;
            }
            st
        };
        let opts = RenderOpts { scale: self.scale(), size: Some((self.width, self.height)), state: Some(&f), ..Default::default() };
        render_slide(&self.pres, slide, &opts)
    }

    fn cues(&self, slide: usize, step: usize, from: f64, to: f64) -> Vec<Cue> {
        let (Some(tl), Some(s)) = (self.timelines.get(slide), self.pres.slides.get(slide)) else { return Vec::new() };
        tl.media_cues(step, from, to)
            .iter()
            .filter_map(|e| s.animations.get(e.anim).map(|a| Cue { shape: e.shape, action: media_action(&a.effect).into() }))
            .collect()
    }
}

fn media_action(effect: &str) -> &'static str {
    match effect {
        "pause" => "pause",
        "stop" => "stop",
        _ => "play",
    }
}

fn progress(now: f64, start: f64, duration: f64) -> f64 {
    let p = (now - start) / duration.max(0.01);
    if p.is_finite() { p.clamp(0.0, 1.0) } else { 1.0 }
}

fn to_frame(img: &Image) -> Frame {
    Frame { width: img.width, height: img.height, rgba: img.to_straight() }
}

fn collect_clips<'a>(shapes: &'a [Shape], out: &mut Vec<(ShapeId, &'a deckcraft_model::MediaClip)>) {
    for s in shapes {
        match &s.kind {
            ShapeKind::Media(clip) => out.push((s.id, clip)),
            ShapeKind::Group { children, .. } => collect_clips(children, out),
            _ => {}
        }
    }
}

fn state_for(tl: &Timeline, id: ShapeId, step: usize, t: f64) -> ShapeState {
    let a = tl.state_ordered(id, None, step, t, &[], &[]);
    ShapeState {
        visible: a.visible,
        opacity: a.opacity,
        offset: deckcraft_geom::Vec2::new(a.offset_x, a.offset_y),
        scale: (a.scale_x, a.scale_y),
        rotate: a.rotate,
        clip: a.clip,
        tint: a.tint,
        paras: tl
            .paragraph_targets(id)
            .into_iter()
            .map(|p| {
                let a = tl.state(id, Some(p), step, t);
                (p, ParaState { visible: a.visible, opacity: a.opacity, offset: deckcraft_geom::Vec2::new(a.offset_x, a.offset_y) })
            })
            .collect(),
    }
}

/// A font the host should fetch for a deck: the first of `candidates` the font server has, in the
/// weight and style closest to `weight` / `italic`. Added with [`Player::add_font_as`] under
/// `family`, or with [`Player::add_font`] when `family` is empty (a face for a script, which text
/// falls back to by itself).
#[derive(Clone, Debug, PartialEq)]
pub struct FontRequest {
    pub family: String,
    pub weight: u16,
    pub italic: bool,
    pub candidates: Vec<String>,
}

/// At most this many font requests per deck: a file can name thousands of families, and each
/// request is a download for the host.
pub const MAX_FONT_REQUESTS: usize = 64;

/// The requests for the families a deck uses, given which are already available (`has`), in
/// first-use order and at most [`MAX_FONT_REQUESTS`] of them (script faces first, so a long list
/// of families can't crowd out the face that draws a language).
fn requests_for(used: &[deckcraft_model::fonts::UsedFont], has: impl Fn(&str) -> bool) -> Vec<FontRequest> {
    use deckcraft_fonts::request::{candidates, category_of, script_family, split_weight};
    let mut out: Vec<FontRequest> = Vec::new();
    let mut push = |r: FontRequest| {
        if out.len() < MAX_FONT_REQUESTS
            && !out
                .iter()
                .any(|o| o.family.eq_ignore_ascii_case(&r.family) && o.weight == r.weight && o.italic == r.italic && o.candidates == r.candidates)
        {
            out.push(r);
        }
    };
    let scripts = used.iter().flat_map(|u| u.chars.chars()).filter_map(deckcraft_fonts::script::script_of);
    for family in scripts.filter_map(script_family) {
        if !has(family) {
            push(FontRequest { family: String::new(), weight: 400, italic: false, candidates: vec![family.to_string()] });
        }
    }
    for u in used.iter().filter(|u| !has(&u.family) && !deckcraft_text::is_symbol_font(&u.family)) {
        let hint = u.hint.as_ref();
        let category = category_of(&u.family, hint.and_then(|h| h.pitch_family), hint.and_then(|h| h.panose.as_deref()));
        let named = split_weight(&u.family).1;
        for &(bold, italic) in &u.styles {
            let weight = named.unwrap_or(if bold { 700 } else { 400 });
            push(FontRequest { family: u.family.clone(), weight, italic, candidates: candidates(&u.family, category) });
        }
    }
    out
}

/// Fonts the deck carries (TrueType or Embedded OpenType), installed for its text.
fn install_embedded_fonts(p: &Presentation) {
    let db = FontDb::global();
    for font in &p.embedded_fonts {
        for id in font.faces().into_iter().flatten() {
            let Some(item) = p.media(id) else { continue };
            let Some(sfnt) = deckcraft_fonts::embedded_sfnt(&item.data) else { continue };
            db.add_font(sfnt.to_vec());
        }
    }
}
