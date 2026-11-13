//! Linked pictures in the player: which slides draw them, which may be fetched, and drawing them
//! once their bytes arrive. Decks are built here and saved as .pptx, so each linked picture goes
//! through the reader as one from PowerPoint's Link to File would (`a:blip r:link`, an external
//! relationship).

use std::io::Cursor;
use std::sync::Arc;

use deckcraft_geom::Xfrm;
use deckcraft_model::style::{Fill, PictureFill};
use deckcraft_model::{Background, MediaItem, Presentation, Shape, ShapeId, ShapeKind};

use super::*;

const BASE: &str = "https://cdn.example.com/decks/42/";

fn png(rgba: [u8; 4]) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(4, 4, image::Rgba(rgba)).write_to(&mut out, image::ImageFormat::Png).expect("png");
    out.into_inner()
}

/// A media item with no bytes, linked to `url`.
fn linked(p: &mut Presentation, url: &str) -> MediaId {
    let id = MediaId(p.alloc_id().expect("id"));
    let name = url.rsplit('/').next().unwrap_or(url).to_string();
    p.media.push(MediaItem { id, name, content_type: "image/png".into(), data: Arc::new(vec![]), link: Some(url.into()) });
    id
}

fn picture(p: &mut Presentation, media: MediaId, x: Xfrm) -> Shape {
    Shape {
        id: ShapeId(p.alloc_id().expect("id")),
        name: "Linked picture".into(),
        xfrm: Some(x),
        kind: ShapeKind::Picture { fill: PictureFill { media, ..Default::default() } },
        ..Default::default()
    }
}

fn full(p: &Presentation) -> Xfrm {
    Xfrm::new(0.0, 0.0, p.slide_size.width, p.slide_size.height)
}

fn small() -> Xfrm {
    Xfrm::new(40.0, 40.0, 120.0, 80.0)
}

fn open(p: &Presentation) -> Player {
    let mut player = Player::open(&deckcraft_pptx::export(p).expect("export")).expect("open");
    player.resize(160);
    player
}

fn url_of(p: &Player, media: MediaId) -> String {
    p.linked_images().into_iter().find(|m| m.media == media).map(|m| m.url).expect("listed")
}

/// The media id the reader gave the picture linked to `url`.
fn id_of(p: &Player, url: &str) -> MediaId {
    p.linked_images().into_iter().find(|m| m.url == url).map(|m| m.media).unwrap_or_else(|| panic!("{url} is not listed"))
}

/// Five slides, each drawing linked pictures a different way:
/// 0: a picture of its own (`own`); 1: `own` again, and a background (`back`); 2: a layout of
/// its own holding a picture (`layout`); 3: a `file:` link, one off the prefix and one escaping
/// it with `..`; 4: hidden, with a picture of its own (`hidden`). The master holds `master`, which
/// every slide draws.
fn deck() -> Presentation {
    let mut p = deckcraft_model::defaults::new_presentation(None);
    let first_layout = p.slides[0].layout;
    let other_layout = p.masters[0].layouts.iter().map(|l| l.id).find(|&id| id != first_layout).expect("a second layout");
    for k in 1..5 {
        let layout = if k == 2 { other_layout } else { first_layout };
        let s = deckcraft_model::defaults::new_slide(&mut p, layout).expect("slide");
        p.slides.push(Arc::new(s));
    }
    let own = linked(&mut p, &format!("{BASE}own.png"));
    let back = linked(&mut p, &format!("{BASE}back.png"));
    let layout = linked(&mut p, &format!("{BASE}layout.png"));
    let master = linked(&mut p, &format!("{BASE}master.png"));
    let file = linked(&mut p, "file:///C:/Users/someone/Pictures/photo.png");
    let off = linked(&mut p, "https://elsewhere.example.org/photo.png");
    let escape = linked(&mut p, &format!("{BASE}../43/photo.png"));
    let hidden = linked(&mut p, &format!("{BASE}hidden.png"));

    let own_pic = picture(&mut p, own, small());
    Arc::make_mut(&mut p.slides[0]).shapes.push(own_pic.clone());
    let again = picture(&mut p, own, small());
    let s1 = Arc::make_mut(&mut p.slides[1]);
    s1.shapes.push(again);
    s1.background = Some(Background::Fill { fill: Fill::Picture(PictureFill { media: back, ..Default::default() }) });
    let layout_pic = picture(&mut p, layout, small());
    let master_pic = picture(&mut p, master, Xfrm::new(800.0, 460.0, 100.0, 60.0));
    {
        let m = Arc::make_mut(&mut p.masters[0]);
        m.shapes.push(master_pic);
        if let Some(l) = m.layouts.iter_mut().find(|l| l.id == other_layout) {
            l.shapes.push(layout_pic);
        }
    }
    for media in [file, off, escape] {
        let pic = picture(&mut p, media, small());
        Arc::make_mut(&mut p.slides[3]).shapes.push(pic);
    }
    let hidden_pic = picture(&mut p, hidden, small());
    let s4 = Arc::make_mut(&mut p.slides[4]);
    s4.shapes.push(hidden_pic);
    s4.hidden = true;
    p
}

fn slides_of(p: &Player, url: &str) -> Vec<usize> {
    p.linked_images().into_iter().find(|m| m.url == url).map(|m| m.slides).unwrap_or_default()
}

#[test]
fn a_linked_picture_is_found_on_the_slides_that_draw_it_however_they_do() {
    let p = open(&deck());
    let u = |name: &str| format!("{BASE}{name}");
    assert_eq!(slides_of(&p, &u("own.png")), [0, 1], "the same picture on two slides is listed once, with both");
    assert_eq!(slides_of(&p, &u("back.png")), [1], "a slide's background");
    assert_eq!(slides_of(&p, &u("layout.png")), [2], "only the slide using that layout");
    assert_eq!(slides_of(&p, &u("master.png")), [0, 1, 2, 3], "every slide of the show draws its master");
    assert!(slides_of(&p, &u("hidden.png")).is_empty(), "a hidden slide isn't shown, so nothing is fetched for it");
    let all = p.linked_images();
    assert!(all.iter().all(|m| !m.loaded && m.content_type == "image/png"), "{all:?}");
    let mut ids = p.slide_linked_images(1);
    ids.sort();
    let mut want = vec![id_of(&p, &u("own.png")), id_of(&p, &u("back.png")), id_of(&p, &u("master.png"))];
    want.sort();
    assert_eq!(ids, want, "the per-slide query");
    assert!(p.slide_linked_images(99).is_empty());
}

#[test]
fn a_file_link_and_an_off_prefix_url_are_never_offered_for_fetching() {
    let p = open(&deck());
    let listed: Vec<String> = p.linked_images().into_iter().map(|m| m.url).collect();
    assert!(listed.iter().any(|u| u.starts_with("file:")), "the reader keeps the link: {listed:?}");
    assert!(listed.iter().any(|u| u.starts_with("https://elsewhere.")), "{listed:?}");
    let offered: Vec<String> = p.linked_images_under(BASE).into_iter().map(|m| m.url).collect();
    let mut names: Vec<&str> = offered.iter().map(|u| u.strip_prefix(BASE).expect("under the prefix")).collect();
    names.sort();
    assert_eq!(names, ["back.png", "layout.png", "master.png", "own.png"]);
}

#[test]
fn only_https_urls_under_the_prefix_pass() {
    let ok = |u: &str| media_url(u, BASE);
    assert_eq!(ok(&format!("{BASE}a/b.png")), Some(format!("{BASE}a/b.png")));
    assert_eq!(ok("HTTPS://CDN.Example.com/decks/42/x.png?sig=1#frag"), Some(format!("{BASE}x.png?sig=1")), "scheme and host ignore case");
    assert_eq!(media_url("https://cdn.example.com/decks/x.png", "https://cdn.example.com/decks"), Some("https://cdn.example.com/decks/x.png".into()));
    for bad in [
        "file:///C:/Users/someone/photo.png",
        "C:\\Users\\someone\\photo.png",
        "photo.png",
        "http://cdn.example.com/decks/42/x.png",
        "https://cdn.example.com/decks/4/x.png",
        "https://cdn.example.com/Decks/42/x.png",
        "https://cdn.example.com.evil.org/decks/42/x.png",
        "https://user:pass@cdn.example.com/decks/42/x.png",
        "https://cdn.example.com/decks/42/../43/x.png",
        "https://cdn.example.com/decks/42/%2e%2e/43/x.png",
        "https://cdn.example.com/decks/42/a%2F..%2F..%2Fx.png",
        "https://cdn.example.com/decks/42/a\\..\\x.png",
        "https://cdn.example.com/decks/42/a b.png",
        "https://cdn.example.com/decks/42/",
        "https://cdn.example.com/decks/42/x.png\n",
    ] {
        assert_eq!(ok(bad), None, "{bad}");
    }
    assert_eq!(ok(&format!("{BASE}{}", "a".repeat(MAX_MEDIA_URL_LEN))), None, "too long");
    for base in
        ["", "http://cdn.example.com/", "https://", "https://u@cdn.example.com/", "https://cdn.example.com/a/../", "https://cdn.example.com/?x"]
    {
        assert_eq!(media_url("https://cdn.example.com/a/x.png", base), None, "base {base:?}");
    }
}

/// The colour at the middle of the slide.
fn middle(f: &Frame) -> [u8; 4] {
    let i = ((f.height / 2 * f.width + f.width / 2) * 4) as usize;
    [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], f.rgba[i + 3]]
}

/// One slide, covered by a linked picture.
fn covered() -> (Presentation, String) {
    let mut p = deckcraft_model::defaults::new_presentation(None);
    let url = format!("{BASE}cover.png");
    let media = linked(&mut p, &url);
    let x = full(&p);
    let pic = picture(&mut p, media, x);
    Arc::make_mut(&mut p.slides[0]).shapes = vec![pic];
    (p, url)
}

/// A picture whose bytes don't decode draws the renderer's missing-picture box (light grey, a grey
/// cross), as it did before linked pictures could be given bytes, and the slide draws as usual.
#[test]
fn a_picture_without_bytes_draws_as_before_and_its_bytes_draw_it() {
    let (deck, url) = covered();
    let mut p = open(&deck);
    let empty = p.frame(0.0).frame.expect("the first picture");
    let grey = middle(&empty);
    assert!(grey[0] > 150 && grey[0] == grey[1] && grey[1] == grey[2], "no picture, the missing-picture box: {grey:?}");
    assert!(p.frame(0.1).frame.is_none(), "nothing changed");

    let media = id_of(&p, &url);
    assert_eq!(p.set_linked_image(media, png([10, 120, 220, 255])), Ok(true), "the slide on screen draws it");
    let drawn = p.frame(0.2).frame.expect("redrawn");
    let c = middle(&drawn);
    assert!(c[0] < 40 && (100..140).contains(&c[1]) && c[2] > 200, "the picture: {c:?}");
    assert!(p.linked_images().iter().all(|m| m.loaded));

    // New bytes replace the old ones.
    assert_eq!(p.set_linked_image(media, png([230, 20, 20, 255])), Ok(true));
    let c = middle(&p.frame(0.3).frame.expect("redrawn"));
    assert!(c[0] > 200 && c[2] < 40, "{c:?}");
}

#[test]
fn bytes_for_a_picture_on_another_slide_wait_for_that_slide() {
    let p0 = deck();
    let mut p = open(&p0);
    p.frame(0.0);
    let layout = id_of(&p, &format!("{BASE}layout.png"));
    assert_eq!(p.set_linked_image(layout, png([0, 0, 0, 255])), Ok(false), "slide 2 isn't on screen");
    assert!(p.frame(0.1).frame.is_none(), "nothing to redraw");
    p.jump(Pos { slide: 2, step: 0 });
    assert!(p.frame(0.2).frame.is_some());
}

#[test]
fn over_limit_and_undecodable_bytes_are_refused_and_change_nothing() {
    let (deck, url) = covered();
    let mut p = open(&deck);
    let before = p.frame(0.0).frame.expect("first");
    let media = id_of(&p, &url);
    assert_eq!(p.set_linked_image(media, vec![0; MAX_LINKED_IMAGE_BYTES + 1]), Err(LinkedImageError::TooLarge));
    assert_eq!(p.set_linked_image(media, b"<html>403 Forbidden</html>".to_vec()), Err(LinkedImageError::Undecodable));
    // A PNG whose header claims 60 000 × 60 000 pixels: past what any picture is decoded to.
    let mut huge = png([0, 0, 0, 255]);
    huge[16..20].copy_from_slice(&60_000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&60_000u32.to_be_bytes());
    assert_eq!(p.set_linked_image(media, huge), Err(LinkedImageError::Undecodable));
    assert_eq!(p.set_linked_image(MediaId(u32::MAX), png([0, 0, 0, 255])), Err(LinkedImageError::Unknown));
    assert!(p.linked_images().iter().all(|m| !m.loaded));
    assert!(p.frame(0.1).frame.is_none(), "refused bytes change nothing");
    p.resize(161);
    p.frame(0.2);
    p.resize(160);
    let after = p.frame(0.3).frame.expect("drawn again");
    assert_eq!(after.rgba, before.rgba, "the slide draws as before the refused bytes");
}

#[test]
fn embedded_pictures_and_linked_videos_are_not_linked_images() {
    // The online-video deck links a video, not a picture.
    let video = Player::open(&super::tests::online_video::deck()).expect("open");
    assert!(video.linked_images().is_empty(), "{:?}", video.linked_images());
    assert_eq!(video.media().len(), 1, "the video is still the host's to play");
    let mut p = deckcraft_model::defaults::new_presentation(None);
    let media = p.add_media("pic.png", "image/png", png([1, 2, 3, 255])).expect("media");
    let pic = picture(&mut p, media, small());
    Arc::make_mut(&mut p.slides[0]).shapes.push(pic);
    let mut embedded = open(&p);
    assert!(embedded.linked_images().is_empty());
    let id = embedded.pres.media.iter().find(|m| m.content_type == "image/png").map(|m| m.id).expect("the embedded picture");
    assert_eq!(embedded.set_linked_image(id, png([9, 9, 9, 255])), Err(LinkedImageError::Unknown), "an embedded picture can't be replaced");
}

#[test]
fn ids_round_trip_through_the_listing() {
    let p = open(&deck());
    for m in p.linked_images() {
        assert_eq!(url_of(&p, m.media), m.url);
    }
}
