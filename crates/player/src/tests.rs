use super::*;

fn sample_pptx() -> Vec<u8> {
    let mut s = deckcraft_engine::Session::new();
    deckcraft_engine::sample::open_sample(&mut s).expect("sample");
    let doc = s.doc().expect("doc").doc.clone();
    deckcraft_pptx::export(&doc).expect("export")
}

fn sample() -> Player {
    let mut p = Player::open(&sample_pptx()).expect("open");
    p.resize(320);
    p
}

/// Every position of the show, in click order.
fn walk(p: &Player) -> Vec<Pos> {
    let mut out = vec![p.position()];
    while let Some(next) = p.next_of(*out.last().expect("start")) {
        out.push(next);
    }
    out
}

/// Play the animation to `target` until it rests; the last picture.
fn play_to(p: &mut Player, target: Pos, now: &mut f64) -> Frame {
    p.advance(target, *now);
    let mut last = Frame::default();
    for _ in 0..2_000 {
        *now += 0.05;
        let tick = p.frame(*now);
        if let Some(f) = tick.frame {
            last = f;
        }
        if !tick.animating && !p.animating() {
            return last;
        }
    }
    panic!("animation to {target:?} never came to rest");
}

#[test]
fn rejects_what_is_not_a_presentation() {
    assert!(matches!(Player::open(b"not a deck"), Err(OpenError::NotPptx)));
    assert!(matches!(Player::open(&[]), Err(OpenError::NotPptx)));
}

#[test]
fn lists_the_show_with_steps_and_notes() {
    let p = sample();
    let slides = p.slides();
    assert!(slides.len() > 3);
    assert_eq!(slides.first().map(|s| s.notes.as_str()), Some("Welcome everyone. This deck was made in DeckCraft."));
    assert!(slides.iter().any(|s| s.steps > 0), "the sample has click builds");
}

#[test]
fn next_and_back_walk_the_whole_show() {
    let p = sample();
    let forward = walk(&p);
    let total: usize = p.slides().iter().map(|s| s.steps - usize::from(s.auto_first) + 1).sum();
    assert_eq!(forward.len(), total);
    let mut back = vec![*forward.last().expect("end")];
    while let Some(prev) = p.prev_of(*back.last().expect("end")) {
        back.push(prev);
    }
    back.reverse();
    // Back lands on each slide fully built, so it visits a subset of the forward positions.
    assert!(back.iter().all(|pos| forward.contains(pos)));
    assert_eq!(back.first(), forward.first());
}

#[test]
fn the_same_position_draws_the_same_picture_however_it_was_reached() {
    let mut walked = sample();
    let mut now = 0.0;
    let positions = walk(&walked);
    let first = walked.frame(now).frame.expect("first picture");
    let mut by_animation = vec![first];
    for &pos in positions.iter().skip(1) {
        by_animation.push(play_to(&mut walked, pos, &mut now));
    }
    let mut jumper = sample();
    for (pos, played) in positions.iter().zip(&by_animation) {
        jumper.jump(*pos);
        let rested = jumper.frame(0.0).frame.expect("picture after a jump");
        assert_eq!((rested.width, rested.height), (played.width, played.height));
        assert!(rested.rgba == played.rgba, "position {pos:?} differs between playing and jumping");
    }
}

#[test]
fn a_click_animates_and_a_jump_does_not() {
    let mut p = sample();
    let positions = walk(&p);
    let click = *positions.get(1).expect("a second position");
    p.frame(0.0);
    p.advance(click, 0.0);
    assert!(p.animating() || p.frame(0.01).animating || click.step == 0, "a click to the next position plays");
    let far = *positions.last().expect("end");
    p.jump(far);
    assert!(!p.animating());
    let tick = p.frame(1.0);
    assert!(tick.frame.is_some() && !tick.animating);
    assert!(p.frame(2.0).frame.is_none(), "nothing new to draw at rest");
}

#[test]
fn a_target_that_is_not_one_click_ahead_is_a_jump() {
    let mut p = sample();
    let positions = walk(&p);
    let far = *positions.get(4).expect("five positions");
    p.advance(far, 0.0);
    assert!(!p.animating());
    assert_eq!(p.position(), far);
}

#[test]
fn positions_out_of_range_are_clamped() {
    let mut p = sample();
    p.jump(Pos { slide: 10_000, step: 10_000 });
    let pos = p.position();
    assert!(pos.slide < p.slides().len() + 1);
    assert!(p.frame(0.0).frame.is_some());
}

#[test]
fn resizing_keeps_the_aspect_and_caps_the_width() {
    let mut p = sample();
    p.resize(100_000);
    let (w, h) = p.size();
    assert_eq!(w, MAX_WIDTH);
    assert!(((w as f64 / h as f64) - p.aspect()).abs() < 0.01);
    let f = p.frame(0.0).frame.expect("picture");
    assert_eq!(f.rgba.len(), (f.width * f.height * 4) as usize);
}

#[test]
fn gpu_transitions_hand_out_layers_and_their_pictures_once() {
    let mut p = sample();
    p.set_gpu_transitions(true);
    p.frame(0.0);
    let positions = walk(&p);
    let next_slide = *positions.iter().find(|pos| pos.slide != positions[0].slide).expect("a second slide");
    p.jump(*positions.iter().rev().find(|pos| pos.slide == positions[0].slide).expect("first slide built"));
    p.frame(0.0);
    p.advance(next_slide, 1.0);
    let first = p.frame(1.01);
    let tr = first.transition.expect("a transition frame");
    assert!(first.frame.is_none());
    let textures = tr.textures.expect("pictures on the first frame");
    assert!(textures.get(1).is_some_and(Option::is_some), "the new slide");
    assert!(!tr.layers.is_empty());
    for l in &tr.layers {
        assert_eq!(l.vertices.len() % 5, 0);
        assert!(l.indices.iter().all(|&i| (i as usize) < l.vertices.len() / 5));
    }
    let second = p.frame(1.02).transition.expect("still in the transition");
    assert!(second.textures.is_none(), "pictures are handed out once");
}
