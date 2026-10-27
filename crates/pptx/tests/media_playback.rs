//! Playback options PowerPoint keeps in a slide's timing rather than on the picture: an audio or
//! video clip's volume, Loop until Stopped and Hide While Not Playing (`p:audio` / `p:video` with a
//! `p:cMediaNode`). The deck is built here and given the timing PowerPoint writes for a waiting
//! screen's background music: start automatically, loop, 7.6% volume, icon hidden when stopped.

use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use deckcraft_model::{MediaClip, Presentation, Shape, ShapeKind, defaults};

/// A one-slide deck with an audio clip named "Music", saved as .pptx.
fn deck_with_music() -> Vec<u8> {
    let mut p = defaults::new_presentation(None);
    let audio = p.add_media("music.mp3", "audio/mpeg", b"mp3-bytes-deckcraft".to_vec()).expect("media");
    let mut music = Shape {
        id: deckcraft_model::ShapeId(p.alloc_id().expect("id")),
        name: "Music".into(),
        xfrm: Some(deckcraft_geom::Xfrm::new(32.0, 480.0, 32.0, 32.0)),
        ..Default::default()
    };
    music.kind = ShapeKind::Media(MediaClip { media: audio, video: false, volume: 1.0, ..Default::default() });
    Arc::make_mut(&mut p.slides[0]).shapes.push(music);
    deckcraft_pptx::export(&p).expect("export")
}

/// The slide's timing as PowerPoint writes it for music that starts with the slide, `node` being
/// the `p:audio` element (or nothing).
fn timing(spid: &str, node: &str) -> String {
    format!(
        r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="afterEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="138448" fill="hold"/><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>{node}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"#
    )
}

fn music_node(spid: &str, attrs: &str, ctn: &str) -> String {
    format!(
        r#"<p:audio><p:cMediaNode {attrs}><p:cTn id="7" {ctn} fill="remove" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:endCondLst><p:cond evt="onStopAudio" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></p:audio>"#
    )
}

/// `bytes` with slide 1's timing replaced by `make(spid of "Music")`, opened again.
fn with_timing(bytes: &[u8], make: impl Fn(&str) -> String) -> Presentation {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip");
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default();
    for i in 0..z.len() {
        let mut f = z.by_index(i).expect("entry");
        let name = f.name().to_string();
        let mut d = vec![];
        f.read_to_end(&mut d).expect("read");
        if name == "ppt/slides/slide1.xml" {
            let mut xml = String::from_utf8(d).expect("utf8");
            let at = xml.find(r#"name="Music""#).expect("the music shape");
            let id_at = xml[..at].rfind(r#"id=""#).expect("its id") + 4;
            let spid = xml[id_at..].split('"').next().expect("id value").to_string();
            if let (Some(s), Some(e)) = (xml.find("<p:timing>"), xml.find("</p:timing>")) {
                xml.replace_range(s..e + "</p:timing>".len(), "");
            }
            let end = xml.rfind("</p:sld>").expect("slide end");
            let ext = xml[..end].rfind("<p:extLst>").filter(|&x| x > xml.find("</p:cSld>").unwrap_or(0)).unwrap_or(end);
            xml.insert_str(ext, &make(&spid));
            d = xml.into_bytes();
        }
        out.start_file(name, o).expect("start");
        out.write_all(&d).expect("write");
    }
    deckcraft_pptx::import(&out.finish().expect("finish").into_inner()).expect("import")
}

fn music(p: &Presentation) -> &MediaClip {
    let s = p.slides[0].shapes.iter().find(|s| s.name == "Music").expect("music shape");
    let ShapeKind::Media(m) = &s.kind else { panic!("{:?}", s.kind) };
    m
}

#[test]
fn volume_loop_and_hiding_come_from_the_media_node() {
    let p =
        with_timing(&deck_with_music(), |spid| timing(spid, &music_node(spid, r#"vol="7576" showWhenStopped="0""#, r#"repeatCount="indefinite""#)));
    let m = music(&p);
    assert!((m.volume - 0.07576).abs() < 1e-9, "volume {}", m.volume);
    assert!(m.loop_play);
    assert!(m.hide_while_not_playing);
}

#[test]
fn without_a_media_node_a_clip_plays_once_at_full_volume() {
    let p = with_timing(&deck_with_music(), |spid| timing(spid, ""));
    let m = music(&p);
    assert_eq!((m.volume, m.loop_play, m.hide_while_not_playing), (1.0, false, false));
}

#[test]
fn a_node_without_volume_or_repeat_keeps_the_defaults() {
    let p = with_timing(&deck_with_music(), |spid| timing(spid, &music_node(spid, "", "")));
    let m = music(&p);
    assert_eq!((m.volume, m.loop_play, m.hide_while_not_playing), (1.0, false, false));
}

#[test]
fn a_hostile_volume_is_clamped() {
    let p = with_timing(&deck_with_music(), |spid| timing(spid, &music_node(spid, r#"vol="999999999""#, "")));
    assert_eq!(music(&p).volume, 1.0);
}

/// A deck whose "Music" clip has `options` applied, saved and opened again; and slide 1's XML.
fn round_trip(options: impl Fn(&mut MediaClip)) -> (Presentation, String) {
    let p = deckcraft_pptx::import(&deck_with_music()).expect("import");
    let mut p = p;
    let slide = Arc::make_mut(&mut p.slides[0]);
    let s = slide.shapes.iter_mut().find(|s| s.name == "Music").expect("music shape");
    let ShapeKind::Media(m) = &mut s.kind else { panic!("{:?}", s.kind) };
    options(m);
    let bytes = deckcraft_pptx::export(&p).expect("export");
    let mut xml = String::new();
    zip::ZipArchive::new(Cursor::new(&bytes)).expect("zip").by_name("ppt/slides/slide1.xml").expect("slide").read_to_string(&mut xml).expect("utf8");
    (deckcraft_pptx::import(&bytes).expect("reimport"), xml)
}

#[test]
fn volume_loop_and_hiding_survive_a_save() {
    let (q, xml) = round_trip(|m| {
        m.volume = 0.25;
        m.loop_play = true;
        m.hide_while_not_playing = true;
    });
    let m = music(&q);
    assert_eq!((m.volume, m.loop_play, m.hide_while_not_playing), (0.25, true, true), "{xml}");
    assert!(xml.contains(r#"<p:cMediaNode vol="25000" showWhenStopped="0">"#), "{xml}");
}

#[test]
fn a_clip_with_default_options_writes_no_media_node() {
    let (q, xml) = round_trip(|_| {});
    assert!(!xml.contains("cMediaNode"), "{xml}");
    assert_eq!(music(&q).volume, 1.0);
}
