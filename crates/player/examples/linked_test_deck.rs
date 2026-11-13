//! Builds a test deck whose pictures are linked (not embedded), and the picture files to host.
//! cargo run -p deckcraft-player --example linked_test_deck -- <https media base> <out dir>
//! With EMBED=1 the same pictures are embedded instead, for a pipeline that takes them out of the
//! deck and links them itself (the `file:` and other-domain links stay links).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use deckcraft_geom::Xfrm;
use deckcraft_model::style::{Fill, PictureFill};
use deckcraft_model::text::TextBody;
use deckcraft_model::{Background, MediaId, MediaItem, Presentation, Shape, ShapeId, ShapeKind};

fn linked(p: &mut Presentation, url: &str) -> MediaId {
    let id = MediaId(p.alloc_id().unwrap());
    let name = url.rsplit('/').next().unwrap().to_string();
    p.media.push(MediaItem { id, name, content_type: "image/png".into(), data: Arc::new(vec![]), link: Some(url.into()) });
    id
}

fn picture(p: &mut Presentation, media: MediaId, x: Xfrm) -> Shape {
    Shape {
        id: ShapeId(p.alloc_id().unwrap()),
        name: "Linked picture".into(),
        xfrm: Some(x),
        kind: ShapeKind::Picture { fill: PictureFill { media, ..Default::default() } },
        ..Default::default()
    }
}

fn label(p: &mut Presentation, text: &str, x: Xfrm) -> Shape {
    Shape {
        id: ShapeId(p.alloc_id().unwrap()),
        name: "Label".into(),
        xfrm: Some(x),
        kind: ShapeKind::Shape,
        text: Some(TextBody::from_text(text)),
        text_box: true,
        ..Default::default()
    }
}

/// A w × h PNG: a solid colour with a darker diagonal band, so stretching and cropping show.
fn png(w: u32, h: u32, c: [u8; 3]) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let band = ((x + y) / 40) % 2 == 0;
        let k = if band { 0.75 } else { 1.0 };
        image::Rgb([(c[0] as f32 * k) as u8, (c[1] as f32 * k) as u8, (c[2] as f32 * k) as u8])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// A noisy w × h PNG that doesn't compress: a large download, to watch a picture arrive late.
fn noise(w: u32, h: u32) -> Vec<u8> {
    let mut s: u32 = 0x1234_5678;
    let img = image::RgbImage::from_fn(w, h, |x, _| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let base = (x * 255 / w) as u8;
        image::Rgb([base, (s & 0x7f) as u8 + 64, 255 - base])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let base = args.get(1).cloned().unwrap_or_else(|| "https://cdn.example.com/deckcraft-test/".into());
    let base = if base.ends_with('/') { base } else { format!("{base}/") };
    let out = std::path::PathBuf::from(args.get(2).cloned().unwrap_or_else(|| "linked-images-test".into()));
    std::fs::create_dir_all(out.join("media")).unwrap();

    let mut p = deckcraft_model::defaults::new_presentation(None);
    let first_layout = p.slides[0].layout;
    let other_layout = p.masters[0].layouts.iter().map(|l| l.id).find(|&id| id != first_layout).unwrap();
    for k in 1..7 {
        let layout = if k == 3 { other_layout } else { first_layout };
        let s = deckcraft_model::defaults::new_slide(&mut p, layout).unwrap();
        p.slides.push(Arc::new(s));
    }
    for s in &mut p.slides {
        Arc::make_mut(s).shapes.clear();
    }

    let embed = std::env::var("EMBED").is_ok();
    let files: Vec<(&str, Vec<u8>)> = vec![
        ("red.png", png(1600, 900, [220, 50, 50])),
        ("background.png", png(1920, 1080, [60, 170, 90])),
        ("layout.png", png(1600, 900, [130, 70, 190])),
        ("master-logo.png", png(320, 200, [40, 110, 220])),
        ("large.png", noise(2400, 1600)),
        ("hidden.png", png(800, 450, [90, 90, 90])),
        ("not-a-picture.png", b"<html><body>403 Forbidden</body></html>".to_vec()),
    ];
    let bytes_of = |name: &str| files.iter().find(|(n, _)| *n == name).map(|(_, b)| b.clone()).unwrap();
    // Embedded, or linked under the base.
    let pic = |p: &mut Presentation, name: &str| {
        if embed { p.add_media(name, "image/png", bytes_of(name)).unwrap() } else { linked(p, &format!("{base}{name}")) }
    };
    let red = pic(&mut p, "red.png");
    let back = pic(&mut p, "background.png");
    let lay = pic(&mut p, "layout.png");
    let logo = pic(&mut p, "master-logo.png");
    let large = pic(&mut p, "large.png");
    let hidden = pic(&mut p, "hidden.png");
    let missing = linked(&mut p, &format!("{base}missing.png"));
    let notpic = linked(&mut p, &format!("{base}not-a-picture.png"));
    let file = linked(&mut p, "file:///C:/Users/presenter/Pictures/photo.png");
    let off = linked(&mut p, "https://example.org/elsewhere/photo.png");

    let title = |p: &mut Presentation, t: &str| label(p, t, Xfrm::new(40.0, 20.0, 880.0, 60.0));
    let note = |p: &mut Presentation, t: &str| label(p, t, Xfrm::new(40.0, 470.0, 740.0, 60.0));
    let put = |p: &mut Presentation, i: usize, shapes: Vec<Shape>| Arc::make_mut(&mut p.slides[i]).shapes.extend(shapes);

    // 1: the starting slide. Its pictures arrive before the first frame.
    let s = vec![
        title(&mut p, "1. Starting slide: linked picture"),
        picture(&mut p, red, Xfrm::new(240.0, 110.0, 480.0, 270.0)),
        note(&mut p, "Expect: a red striped picture, and the small blue logo bottom right, on the very first frame."),
    ];
    put(&mut p, 0, s);
    // 2: a linked picture as the slide's background.
    let s = vec![title(&mut p, "2. Linked picture as background"), note(&mut p, "Expect: a green striped background behind this text.")];
    put(&mut p, 1, s);
    Arc::make_mut(&mut p.slides[1]).background = Some(Background::Fill { fill: Fill::Picture(PictureFill { media: back, ..Default::default() }) });
    // 3: the same picture as slide 1, fetched once.
    let s = vec![
        title(&mut p, "3. Same picture as slide 1"),
        picture(&mut p, red, Xfrm::new(80.0, 110.0, 320.0, 180.0)),
        picture(&mut p, red, Xfrm::new(560.0, 200.0, 320.0, 180.0)),
        note(&mut p, "Expect: two red pictures. red.png is downloaded only once."),
    ];
    put(&mut p, 2, s);
    // 4: a slide whose layout holds a linked picture.
    let s = vec![
        title(&mut p, "4. Picture from the slide's layout"),
        note(&mut p, "Expect: a purple striped picture, which comes from the layout, not the slide."),
    ];
    put(&mut p, 3, s);
    // 5: a large picture that arrives after the first frame.
    let s = vec![
        title(&mut p, "5. Large picture (about 7 MB)"),
        picture(&mut p, large, Xfrm::new(240.0, 110.0, 480.0, 320.0)),
        note(&mut p, "Expect: a noisy blue-to-orange picture. If you jump here at once it may appear a moment late and redraw."),
    ];
    put(&mut p, 4, s);
    // 6: pictures that must not be drawn.
    let w = 200.0;
    // The links that stay links, after the two failure cases when those are there.
    let x0 = if embed { 40.0 } else { 500.0 };
    let mut s = vec![title(&mut p, "6. Pictures that must not load")];
    if !embed {
        s.extend([
            picture(&mut p, missing, Xfrm::new(40.0, 120.0, w, 140.0)),
            label(&mut p, "missing.png (404): image-unavailable", Xfrm::new(40.0, 270.0, w, 60.0)),
            picture(&mut p, notpic, Xfrm::new(270.0, 120.0, w, 140.0)),
            label(&mut p, "not-a-picture.png: image-unavailable, undecodable", Xfrm::new(270.0, 270.0, w, 60.0)),
        ]);
    }
    s.extend([
        picture(&mut p, file, Xfrm::new(x0, 120.0, w, 140.0)),
        label(&mut p, "file: link (linked in PowerPoint): never requested", Xfrm::new(x0, 270.0, w, 60.0)),
        picture(&mut p, off, Xfrm::new(x0 + 230.0, 120.0, w, 140.0)),
        label(&mut p, "other domain (linked in PowerPoint): never requested", Xfrm::new(x0 + 230.0, 270.0, w, 60.0)),
    ]);
    let expect = if embed {
        "Expect: two grey boxes with a cross; no request to example.org or a file path."
    } else {
        "Expect: four grey boxes with a cross; two image-unavailable errors; no request to example.org or a file path."
    };
    s.push(note(&mut p, expect));
    put(&mut p, 5, s);
    // 7: hidden: its picture is never fetched.
    let s = vec![title(&mut p, "7. Hidden slide"), picture(&mut p, hidden, Xfrm::new(240.0, 110.0, 480.0, 270.0))];
    put(&mut p, 6, s);
    Arc::make_mut(&mut p.slides[6]).hidden = true;

    let lay_pic = picture(&mut p, lay, Xfrm::new(240.0, 110.0, 480.0, 270.0));
    let logo_pic = picture(&mut p, logo, Xfrm::new(860.0, 470.0, 80.0, 50.0));
    {
        let m = Arc::make_mut(&mut p.masters[0]);
        m.shapes.push(logo_pic);
        if let Some(l) = m.layouts.iter_mut().find(|l| l.id == other_layout) {
            l.shapes.push(lay_pic);
        }
    }

    let deck = deckcraft_pptx::export(&p).unwrap();
    std::fs::write(out.join("linked-images-test.pptx"), &deck).unwrap();
    for (name, bytes) in files.iter().filter(|(n, _)| !embed && *n != "hidden.png") {
        std::fs::write(out.join("media").join(name), bytes).unwrap();
    }
    println!("base {base}");
    println!("wrote {}", out.display());
    if std::env::var("VERIFY").is_ok() {
        verify(&deck, &base, &out);
    }
}

/// What the browser would do: list the pictures under the prefix, hand each one's bytes in (as if
/// fetched from out/media), and draw every slide of the show to out/preview-N.png.
fn verify(deck: &[u8], base: &str, out: &std::path::Path) {
    use deckcraft_player::{Player, Pos};
    let mut player = Player::open(deck).unwrap();
    player.resize(960);
    println!("all linked: {}", player.linked_images().len());
    for m in player.linked_images_under(base) {
        let name = m.url.strip_prefix(base).unwrap().to_string();
        let res = match std::fs::read(out.join("media").join(&name)) {
            Ok(bytes) => format!("{:?}", player.set_linked_image(m.media, bytes)),
            Err(_) => "404 (not hosted)".into(),
        };
        println!("  offered {name:<20} slides {:?} -> {res}", m.slides);
    }
    for s in player.slides() {
        player.jump(Pos { slide: s.index, step: 0 });
        let f = player.frame(s.index as f64).frame.unwrap();
        let img = image::RgbaImage::from_raw(f.width, f.height, f.rgba).unwrap();
        img.save(out.join(format!("preview-{}.png", s.index + 1))).unwrap();
    }
}
