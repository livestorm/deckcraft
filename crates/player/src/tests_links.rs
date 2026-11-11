//! Links in the player: where they are, which one a click follows, and where they go. Decks are
//! built here and saved as .pptx, so each link goes through the reader as one from PowerPoint would.

use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use deckcraft_geom::Xfrm;
use deckcraft_model::style::PictureFill;
use deckcraft_model::text::{Action, Hyperlink, Run, RunProps, TextBody};
use deckcraft_model::{AnimClass, AnimStart, Animation, Presentation, Shape, ShapeId, ShapeKind, SlideId};

use super::*;
use crate::links::{allowed_url, target};

const LINKED: &str = "our wonderfully long linked website";

fn link(action: Action) -> Option<Hyperlink> {
    Some(Hyperlink { action, tooltip: String::new(), highlight_click: false, sound: None, stop_sound: false, zoom_return: None })
}

fn url(u: &str) -> Option<Hyperlink> {
    link(Action::Url { url: u.into() })
}

fn shape(p: &mut Presentation, name: &str, x: Xfrm, click: Option<Hyperlink>) -> Shape {
    Shape { id: ShapeId(p.alloc_id().expect("id")), name: name.into(), xfrm: Some(x), kind: ShapeKind::Shape, click, ..Default::default() }
}

fn png() -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(2, 2, image::Rgba([200, 30, 30, 255])).write_to(&mut out, image::ImageFormat::Png).expect("png");
    out.into_inner()
}

/// Four slides (file ids 256 to 259). The first holds every kind of link, laid out apart on a
/// 960 × 540 pt slide; the others are plain.
struct Deck {
    pres: Presentation,
    ids: std::collections::HashMap<&'static str, ShapeId>,
}

fn deck() -> Deck {
    let mut p = deckcraft_model::defaults::new_presentation(None);
    let layout = p.slides[0].layout;
    for _ in 0..3 {
        let s = deckcraft_model::defaults::new_slide(&mut p, layout).expect("slide");
        p.slides.push(Arc::new(s));
    }
    let third = p.slides[2].id;
    let mut shapes = Vec::new();
    shapes.push(shape(&mut p, "a", Xfrm::new(40.0, 40.0, 160.0, 80.0), url("https://example.com/a")));
    let media = p.add_media("pic.png", "image/png", png()).expect("media");
    let mut pic = shape(&mut p, "pic", Xfrm::new(240.0, 40.0, 160.0, 80.0), url("mailto:team@example.com"));
    pic.kind = ShapeKind::Picture { fill: PictureFill { media, ..Default::default() } };
    pic.descr = "Write to the team".into();
    shapes.push(pic);
    // A text box whose linked run wraps over several lines.
    let mut text = shape(&mut p, "text", Xfrm::new(440.0, 40.0, 140.0, 160.0), None);
    let mut body = TextBody::from_text("Visit ");
    let props = RunProps { link: url("https://example.com/run"), ..Default::default() };
    if let Some(para) = body.paragraphs.first_mut() {
        para.runs.push(Run::with(LINKED, props));
        para.runs.push(Run::with(" today", RunProps::default()));
    }
    text.text = Some(body);
    text.text_box = true;
    shapes.push(text);
    shapes.push(shape(&mut p, "tel", Xfrm::new(620.0, 40.0, 120.0, 60.0), url("tel:+33123456789")));
    // A group at (780, 40) 160 × 80 whose child space is twice as large: its children are drawn at
    // half size.
    let next = shape(&mut p, "next", Xfrm::new(0.0, 0.0, 160.0, 80.0), link(Action::NextSlide));
    let prev = shape(&mut p, "prev", Xfrm::new(160.0, 80.0, 160.0, 80.0), link(Action::PreviousSlide));
    let group = Shape {
        id: ShapeId(p.alloc_id().expect("id")),
        name: "group".into(),
        xfrm: Some(Xfrm::new(780.0, 40.0, 160.0, 80.0)),
        kind: ShapeKind::Group { children: vec![next, prev], child: Xfrm::new(0.0, 0.0, 320.0, 160.0) },
        ..Default::default()
    };
    shapes.push(group);
    // 200 × 40 turned a quarter turn about its centre (140, 270): it stands from y 170 to 370.
    let mut turned = Xfrm::new(40.0, 250.0, 200.0, 40.0);
    turned.rot = 90.0;
    shapes.push(shape(&mut p, "turned", turned, url("https://example.com/turned")));
    // 200 × 40 tilted 30° about its centre (640, 340): its bounding box runs from about (543, 273)
    // to (737, 407), its corners well inside that box's corners.
    let mut tilted = Xfrm::new(540.0, 320.0, 200.0, 40.0);
    tilted.rot = 30.0;
    shapes.push(shape(&mut p, "tilted", tilted, url("https://example.com/tilted")));
    let mut flipped = Xfrm::new(40.0, 460.0, 120.0, 40.0);
    flipped.flip_h = true;
    flipped.flip_v = true;
    shapes.push(shape(&mut p, "flipped", flipped, url("https://example.com/flipped")));
    shapes.push(shape(&mut p, "slide", Xfrm::new(300.0, 200.0, 120.0, 60.0), link(Action::Slide { slide: third })));
    shapes.push(shape(&mut p, "js", Xfrm::new(450.0, 200.0, 120.0, 60.0), url("javascript:alert(1)")));
    shapes.push(shape(&mut p, "data", Xfrm::new(600.0, 200.0, 120.0, 60.0), url("data:text/html,<script>alert(1)</script>")));
    shapes.push(shape(&mut p, "later", Xfrm::new(780.0, 200.0, 120.0, 60.0), url("https://example.com/later")));
    shapes.push(shape(&mut p, "covered", Xfrm::new(300.0, 400.0, 160.0, 80.0), url("https://example.com/covered")));
    shapes.push(shape(&mut p, "cover", Xfrm::new(360.0, 400.0, 160.0, 80.0), None));
    let later = shapes.iter().find(|s| s.name == "later").map(|s| s.id).expect("later");
    let ids = shapes.iter().map(|s| (leak(&s.name), s.id)).collect();
    let slide = Arc::make_mut(&mut p.slides[0]);
    slide.shapes.extend(shapes);
    slide.animations.push(Animation {
        shape: later,
        class: AnimClass::Entrance,
        effect: "appear".into(),
        start: AnimStart::OnClick,
        duration_ms: 500,
        ..Default::default()
    });
    Deck { pres: p, ids }
}

fn leak(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn open(bytes: &[u8]) -> Player {
    let mut p = Player::open(bytes).expect("open");
    p.resize(320);
    p
}

fn player() -> (Player, Deck) {
    let d = deck();
    (open(&deckcraft_pptx::export(&d.pres).expect("export")), d)
}

/// The link at (`x`, `y`) in slide points.
fn at(p: &mut Player, x: f64, y: f64) -> Option<LinkRegion> {
    let s = p.pres.slide_size;
    p.link_at(x / s.width, y / s.height)
}

fn target_at(p: &mut Player, x: f64, y: f64) -> Option<LinkTarget> {
    at(p, x, y).map(|r| r.target)
}

fn web(u: &str) -> Option<LinkTarget> {
    Some(LinkTarget::Url(u.into()))
}

#[test]
fn the_slide_is_960_by_540() {
    let (p, _) = player();
    assert_eq!((p.pres.slide_size.width, p.pres.slide_size.height), (960.0, 540.0));
}

#[test]
fn a_link_on_a_shape_covers_the_shape_and_nothing_else() {
    let (mut p, d) = player();
    let r = at(&mut p, 120.0, 80.0).expect("on the shape");
    assert_eq!(r.target, LinkTarget::Url("https://example.com/a".into()));
    assert_eq!(r.shape, d.ids["a"]);
    assert!(!r.text);
    assert_eq!(target_at(&mut p, 120.0, 130.0), None, "just below it");
    assert_eq!(target_at(&mut p, 20.0, 80.0), None, "just left of it");
    let region = p.links().into_iter().find(|l| l.shape == d.ids["a"]).expect("listed");
    let [x, y, w, h] = region.rect;
    assert!((x - 40.0 / 960.0).abs() < 1e-9 && (y - 40.0 / 540.0).abs() < 1e-9, "{:?}", region.rect);
    assert!((w - 160.0 / 960.0).abs() < 1e-9 && (h - 80.0 / 540.0).abs() < 1e-9, "{:?}", region.rect);
}

#[test]
fn a_link_on_a_picture_and_a_mail_link() {
    let (mut p, _) = player();
    let r = at(&mut p, 320.0, 80.0).expect("on the picture");
    assert_eq!(r.target, LinkTarget::Url("mailto:team@example.com".into()));
    assert_eq!(r.label, "Write to the team", "labelled by its alternative text");
}

#[test]
fn a_phone_link() {
    let (mut p, _) = player();
    assert_eq!(target_at(&mut p, 680.0, 70.0), web("tel:+33123456789"));
}

#[test]
fn a_link_on_a_run_of_text_has_a_box_per_line_and_only_the_run_is_a_link() {
    let (mut p, d) = player();
    let boxes: Vec<LinkRegion> = p.links().into_iter().filter(|l| l.text).collect();
    assert!(boxes.len() >= 2, "the run wraps: {boxes:?}");
    assert!(boxes.iter().all(|b| b.shape == d.ids["text"] && b.target == LinkTarget::Url("https://example.com/run".into())));
    assert!(boxes.iter().all(|b| b.label == LINKED), "labelled by the linked text: {boxes:?}");
    let tops: Vec<f64> = boxes.iter().map(|b| b.rect[1]).collect();
    assert!(tops.windows(2).all(|w| w[1] > w[0]), "one line under the other: {tops:?}");
    for b in &boxes {
        let [x, y, w, h] = b.rect;
        assert!(x >= 440.0 / 960.0 - 1e-6 && x + w <= 580.0 / 960.0 + 1e-6, "inside the text box: {:?}", b.rect);
        let hit = p.link_at(x + w / 2.0, y + h / 2.0);
        assert_eq!(hit.map(|h| h.target), web("https://example.com/run"), "{b:?}");
    }
    // "Visit " starts the first line, left of the link's first box.
    let first = &boxes[0];
    assert!(first.rect[0] > 450.0 / 960.0, "the run starts after \"Visit \": {:?}", first.rect);
    let y = first.rect[1] + first.rect[3] / 2.0;
    assert_eq!(p.link_at(445.0 / 960.0, y), None, "the text before the run is no link");
    let last = boxes.last().expect("last");
    assert_eq!(p.link_at(last.rect[0] + last.rect[2] / 2.0, (last.rect[1] + last.rect[3]) + 60.0 / 540.0), None, "below the text");
}

#[test]
fn links_in_a_group_follow_the_groups_scale() {
    let (mut p, _) = player();
    // The children are drawn at half size: next at (780, 40) 80 × 40, previous at (860, 80).
    assert_eq!(target_at(&mut p, 820.0, 60.0), Some(LinkTarget::NextSlide));
    assert_eq!(target_at(&mut p, 900.0, 100.0), Some(LinkTarget::PreviousSlide));
    assert_eq!(target_at(&mut p, 900.0, 60.0), None, "the group's empty corner");
}

#[test]
fn a_link_on_a_turned_shape_covers_it_as_turned() {
    let (mut p, d) = player();
    assert_eq!(target_at(&mut p, 140.0, 200.0), web("https://example.com/turned"), "inside, above the unturned box");
    assert_eq!(target_at(&mut p, 60.0, 270.0), None, "inside the unturned box, outside the turned one");
    let r = p.links().into_iter().find(|l| l.shape == d.ids["turned"]).expect("listed");
    let [x, y, w, h] = r.rect;
    let close = |a: f64, b: f64| (a - b).abs() < 1e-6;
    assert!(close(x * 960.0, 120.0) && close(y * 540.0, 170.0) && close(w * 960.0, 40.0) && close(h * 540.0, 200.0), "{:?}", r.rect);
}

#[test]
fn a_link_on_a_tilted_shape_covers_its_outline_not_its_bounding_box() {
    let (mut p, _) = player();
    assert_eq!(target_at(&mut p, 640.0, 340.0), web("https://example.com/tilted"));
    for (x, y) in [(730.0, 280.0), (550.0, 280.0), (730.0, 400.0), (550.0, 400.0)] {
        assert_eq!(target_at(&mut p, x, y), None, "a corner of the bounding box: {x}, {y}");
    }
}

#[test]
fn a_link_on_a_flipped_shape() {
    let (mut p, _) = player();
    assert_eq!(target_at(&mut p, 100.0, 480.0), web("https://example.com/flipped"));
    assert_eq!(target_at(&mut p, 100.0, 510.0), None);
}

#[test]
fn a_link_to_a_slide_names_it_by_index_and_file_id() {
    let (mut p, _) = player();
    assert_eq!(target_at(&mut p, 360.0, 230.0), Some(LinkTarget::Slide { index: 2, file_id: Some(258) }));
}

#[test]
fn script_and_data_links_are_refused_and_listed_nowhere() {
    let (mut p, d) = player();
    assert_eq!(target_at(&mut p, 510.0, 230.0), None, "javascript:");
    assert_eq!(target_at(&mut p, 660.0, 230.0), None, "data:");
    let shapes: Vec<ShapeId> = p.links().iter().map(|l| l.shape).collect();
    assert!(!shapes.contains(&d.ids["js"]) && !shapes.contains(&d.ids["data"]));
}

#[test]
fn a_shape_without_a_link_blocks_the_link_beneath_it() {
    let (mut p, _) = player();
    assert_eq!(target_at(&mut p, 320.0, 440.0), web("https://example.com/covered"));
    assert_eq!(target_at(&mut p, 400.0, 440.0), None);
}

#[test]
fn a_shape_not_yet_animated_in_is_no_link_until_it_is() {
    let (mut p, d) = player();
    assert_eq!(p.position(), Pos { slide: 0, step: 0 });
    assert_eq!(target_at(&mut p, 840.0, 230.0), None);
    assert!(p.links().iter().all(|l| l.shape != d.ids["later"]));
    p.jump(Pos { slide: 0, step: 1 });
    assert_eq!(target_at(&mut p, 840.0, 230.0), web("https://example.com/later"));
    assert!(p.links().iter().any(|l| l.shape == d.ids["later"]));
}

#[test]
fn another_slide_has_its_own_links() {
    let (mut p, _) = player();
    assert!(!p.links().is_empty());
    p.jump(Pos { slide: 1, step: 0 });
    assert!(p.links().is_empty());
    assert_eq!(target_at(&mut p, 120.0, 80.0), None);
    p.jump(Pos { slide: 0, step: 0 });
    assert!(target_at(&mut p, 120.0, 80.0).is_some());
}

#[test]
fn every_hit_is_one_of_the_listed_links() {
    let (mut p, _) = player();
    let listed = p.links();
    for i in 0..48 {
        for j in 0..27 {
            let (x, y) = ((f64::from(i) + 0.5) / 48.0, (f64::from(j) + 0.5) / 27.0);
            if let Some(hit) = p.link_at(x, y) {
                assert!(listed.contains(&hit), "{hit:?}");
            }
        }
    }
}

#[test]
fn points_off_the_slide_or_not_numbers_are_no_link() {
    let (mut p, _) = player();
    for (x, y) in [(f64::NAN, 0.1), (0.1, f64::INFINITY), (-1.0, 0.1), (2.0, 2.0)] {
        assert_eq!(p.link_at(x, y), None);
    }
}

/// `bytes` with the slide whose file id is `drop` left out of the slide list, as the attendee
/// copy leaves out hidden slides.
fn without_slide(bytes: &[u8], drop: u32) -> Vec<u8> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default();
    for i in 0..z.len() {
        let mut f = z.by_index(i).expect("entry");
        let name = f.name().to_string();
        let mut d = vec![];
        f.read_to_end(&mut d).expect("read");
        if name == "ppt/presentation.xml" {
            let xml = String::from_utf8(d).expect("utf8");
            let start = xml.find(&format!(r#"<p:sldId id="{drop}""#)).expect("the slide");
            let end = start + xml[start..].find("/>").expect("its end") + 2;
            d = format!("{}{}", &xml[..start], &xml[end..]).into_bytes();
        }
        out.start_file(name, o).expect("start");
        out.write_all(&d).expect("write");
    }
    out.finish().expect("finish").into_inner()
}

#[test]
fn a_link_to_a_slide_the_copy_left_out_is_dropped() {
    let d = deck();
    let copy = without_slide(&deckcraft_pptx::export(&d.pres).expect("export"), 258);
    let mut p = open(&copy);
    assert_eq!(p.slides().len(), 3);
    assert_eq!(target_at(&mut p, 360.0, 230.0), None);
    assert!(p.links().iter().all(|l| !matches!(l.target, LinkTarget::Slide { .. })));
    assert_eq!(target_at(&mut p, 120.0, 80.0), web("https://example.com/a"), "the rest still work");
}

#[test]
fn a_slide_target_must_be_a_slide_of_the_show() {
    let d = deck();
    let order: Vec<usize> = (0..d.pres.slides.len()).collect();
    assert_eq!(target(&d.pres, &order, &Action::Slide { slide: SlideId(987_654) }), None, "no such slide");
    let third = d.pres.slides[2].id;
    assert!(target(&d.pres, &order, &Action::Slide { slide: third }).is_some());
    assert_eq!(target(&d.pres, &[0, 1, 3], &Action::Slide { slide: third }), None, "hidden: not in the show");
    for a in [Action::LastViewed, Action::PlayMedia, Action::Program { path: "calc.exe".into() }] {
        assert_eq!(target(&d.pres, &order, &a), None, "{a:?}");
    }
    assert_eq!(target(&d.pres, &order, &Action::EndShow), Some(LinkTarget::EndShow));
}

#[test]
fn only_web_mail_and_phone_urls_are_allowed() {
    for ok in
        ["https://example.com", "http://example.com/a?b=c#d", " https://example.com/x ", "HTTPS://EXAMPLE.COM", "mailto:a@b.c", "tel:+1-555-0100"]
    {
        assert_eq!(allowed_url(ok).as_deref(), Some(ok.trim()), "{ok}");
    }
    let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
    for bad in [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,hi",
        "file:///etc/passwd",
        "../slide3.xml",
        "slide3.xml",
        "//example.com",
        "https://",
        "https:///path",
        "https:example.com",
        "https://exa mple.com",
        "https://example.com/\u{0}",
        "mailto:",
        "tel:",
        "tel:<script>",
        "vbscript:x",
        "ms-word:ofe|u|https://example.com",
        "",
        &long,
    ] {
        assert_eq!(allowed_url(bad), None, "{bad}");
    }
}

#[test]
fn a_youtube_videos_play_action_is_no_link() {
    // An online video's picture carries `ppaction://media`: playing it is the media layer's job.
    let mut p = open(&crate::tests::online_video::deck());
    assert!(p.links().is_empty());
    assert_eq!(p.link_at(0.5, 0.5), None);
}

#[test]
fn labels_are_bounded() {
    let mut d = deck();
    let slide = Arc::make_mut(&mut d.pres.slides[0]);
    if let Some(s) = slide.shapes.iter_mut().find(|s| s.name == "a") {
        s.descr = "word ".repeat(10_000);
        if let Some(h) = s.click.as_mut() {
            h.tooltip = "tip\n\t".repeat(10_000);
        }
    }
    let mut p = open(&deckcraft_pptx::export(&d.pres).expect("export"));
    let r = at(&mut p, 120.0, 80.0).expect("link");
    assert_eq!(r.label.chars().count(), MAX_LABEL_CHARS);
    assert!(r.tooltip.chars().count() <= MAX_LABEL_CHARS && !r.tooltip.contains('\n'));
}

#[test]
fn at_most_max_links_regions() {
    let mut p = deckcraft_model::defaults::new_presentation(None);
    let mut shapes = Vec::new();
    for i in 0..(MAX_LINKS + 50) {
        let x = (i % 40) as f64 * 24.0;
        let y = (i / 40) as f64 * 40.0;
        shapes.push(shape(&mut p, "s", Xfrm::new(x, y, 20.0, 20.0), url(&format!("https://example.com/{i}"))));
    }
    Arc::make_mut(&mut p.slides[0]).shapes = shapes;
    let mut player = open(&deckcraft_pptx::export(&p).expect("export"));
    assert_eq!(player.links().len(), MAX_LINKS);
}

#[test]
fn a_link_in_a_paragraph_not_yet_built_is_no_link_until_it_is() {
    let mut p = deckcraft_model::defaults::new_presentation(None);
    let mut text = shape(&mut p, "text", Xfrm::new(100.0, 100.0, 400.0, 200.0), None);
    let mut body = TextBody::from_text("First point\nSecond point ");
    if let Some(para) = body.paragraphs.get_mut(1) {
        para.runs.push(Run::with("with a link", RunProps { link: url("https://example.com/second"), ..Default::default() }));
    }
    text.text = Some(body);
    text.text_box = true;
    let id = text.id;
    let slide = Arc::make_mut(&mut p.slides[0]);
    slide.shapes.push(text);
    slide.animations.push(Animation {
        shape: id,
        class: AnimClass::Entrance,
        effect: "appear".into(),
        start: AnimStart::OnClick,
        duration_ms: 500,
        paragraph: Some(1),
        ..Default::default()
    });
    let mut player = open(&deckcraft_pptx::export(&p).expect("export"));
    assert_eq!(player.slides().first().map(|s| s.steps), Some(1), "the second paragraph builds on a click");
    assert!(player.links().is_empty(), "{:?}", player.links());
    player.jump(Pos { slide: 0, step: 1 });
    let links = player.links();
    assert_eq!(links.len(), 1, "{links:?}");
    assert_eq!(links[0].target, LinkTarget::Url("https://example.com/second".into()));
    let [x, y, w, h] = links[0].rect;
    assert_eq!(player.link_at(x + w / 2.0, y + h / 2.0).map(|l| l.target), web("https://example.com/second"));
}
