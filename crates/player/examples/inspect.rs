//! `cargo run -p deckcraft-player --example inspect -- DECK.pptx [OUT_DIR] [WIDTH]`: list the
//! show's slides, steps and media, and render every position at rest to `OUT_DIR/NN-SS.png`.

use std::path::PathBuf;
use std::time::Instant;

use deckcraft_player::Player;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let deck = PathBuf::from(args.next().ok_or("usage: inspect DECK.pptx [OUT_DIR] [WIDTH]")?);
    let out = args.next().map(PathBuf::from);
    let width: u32 = args.next().map(|w| w.parse()).transpose()?.unwrap_or(1280);
    let bytes = std::fs::read(&deck)?;
    let t = Instant::now();
    let mut p = Player::open(&bytes)?;
    println!("opened {} in {:?}", deck.display(), t.elapsed());
    for w in p.warnings() {
        println!("warning: {w}");
    }
    for s in p.slides() {
        println!("slide {:>3}  steps {}  auto-first {:<5}  {:?}", s.index, s.steps, s.auto_first, s.title);
    }
    for m in p.media() {
        println!(
            "media slide {} shape {} video {} {} {} bytes link {:?} rect {:?}",
            m.slide,
            m.shape.0,
            m.video,
            m.content_type,
            m.data.len(),
            m.link,
            m.rect
        );
    }
    let Some(out) = out else { return Ok(()) };
    std::fs::create_dir_all(&out)?;
    p.resize(width);
    let mut pos = Some(p.position());
    while let Some(at) = pos {
        p.jump(at);
        let t = Instant::now();
        let frame = p.frame(0.0).frame.ok_or("no picture")?;
        let ms = t.elapsed().as_millis();
        let img = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba).ok_or("bad frame")?;
        let path = out.join(format!("{:02}-{:02}.png", at.slide, at.step));
        img.save(&path)?;
        println!("rendered {} in {ms} ms", path.display());
        pos = p.next_of(at);
    }
    Ok(())
}
