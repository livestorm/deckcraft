use deckcraft_player::Frame;
use deckcraft_player::{Player, Pos};
use js_sys::{Array, Float32Array, Object, Reflect, Uint8Array, Uint8ClampedArray, Uint32Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| web_sys::console::error_1(&format!("deckcraft player panicked: {info}").into())));
}

#[wasm_bindgen]
pub struct WebPlayer {
    inner: Player,
}

#[wasm_bindgen]
impl WebPlayer {
    /// Open a `.pptx` / `.ppsx` from its bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WebPlayer, JsError> {
        Player::open(bytes).map(|inner| WebPlayer { inner }).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Add a font (TTF, OTF or TTC); call before opening a deck. Returns the faces added.
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(bytes: Vec<u8>) -> usize {
        Player::add_font(bytes)
    }

    /// Another deck's speaker notes, by file slide id, without opening it: `[{fileId, notes}]`.
    /// A presenter on the attendee copy matches them to `info().slides[].fileId`.
    #[wasm_bindgen(js_name = notesOf)]
    pub fn notes_of(bytes: &[u8]) -> Result<JsValue, JsError> {
        let out = Array::new();
        for n in Player::notes_of(bytes).map_err(|e| JsError::new(&e.to_string()))? {
            let o = Object::new();
            set(&o, "fileId", f64::from(n.file_id)).map_err(|_| JsError::new("notes"))?;
            set(&o, "notes", n.notes.as_str()).map_err(|_| JsError::new("notes"))?;
            out.push(&o);
        }
        Ok(out.into())
    }

    /// Add a font under the family name a deck uses (a font request's `family`). Returns the
    /// faces added.
    #[wasm_bindgen(js_name = addFontAs)]
    pub fn add_font_as(bytes: Vec<u8>, family: &str) -> usize {
        Player::add_font_as(bytes, family)
    }

    /// The fonts this deck needs and doesn't have: `[{family, weight, italic, candidates}]`.
    /// Fetch the first candidate the font server has, in the face closest to `weight`/`italic`,
    /// and add it with `addFontAs(bytes, family)`, or `addFont(bytes)` when `family` is empty.
    #[wasm_bindgen(js_name = fontRequests)]
    pub fn font_requests(&self) -> Result<JsValue, JsValue> {
        let out = Array::new();
        for r in self.inner.font_requests() {
            let o = Object::new();
            set(&o, "family", r.family.as_str())?;
            set(&o, "weight", f64::from(r.weight))?;
            set(&o, "italic", r.italic)?;
            let candidates: Array = r.candidates.iter().map(|c| JsValue::from_str(c)).collect();
            set(&o, "candidates", candidates)?;
            out.push(&o);
        }
        Ok(out.into())
    }

    /// `{aspect, warnings, slides: [{index, title, notes, fileId, steps, autoFirst}]}`
    pub fn info(&self) -> Result<JsValue, JsValue> {
        let slides = Array::new();
        for s in self.inner.slides() {
            let o = Object::new();
            set(&o, "index", s.index as f64)?;
            set(&o, "title", s.title.as_str())?;
            set(&o, "notes", s.notes.as_str())?;
            set(&o, "fileId", s.file_id.map_or(JsValue::NULL, |id| JsValue::from_f64(f64::from(id))))?;
            set(&o, "steps", s.steps as f64)?;
            set(&o, "autoFirst", s.auto_first)?;
            slides.push(&o);
        }
        let warnings: Array = self.inner.warnings().iter().map(|w| JsValue::from_str(w)).collect();
        let o = Object::new();
        set(&o, "aspect", self.inner.aspect())?;
        set(&o, "warnings", warnings)?;
        set(&o, "slides", slides)?;
        Ok(o.into())
    }

    pub fn position(&self) -> Vec<u32> {
        from_pos(self.inner.position())
    }

    /// Where a click goes from `[slide, step]`; `undefined` at the end of the show.
    #[wasm_bindgen(js_name = nextOf)]
    pub fn next_of(&self, slide: u32, step: u32) -> Option<Vec<u32>> {
        self.inner.next_of(to_pos(slide, step)).map(from_pos)
    }

    /// Where Back goes from `[slide, step]`; `undefined` at the start of the show.
    #[wasm_bindgen(js_name = prevOf)]
    pub fn prev_of(&self, slide: u32, step: u32) -> Option<Vec<u32>> {
        self.inner.prev_of(to_pos(slide, step)).map(from_pos)
    }

    /// The position slide `slide` is entered at.
    pub fn entry(&self, slide: u32) -> Vec<u32> {
        from_pos(self.inner.entry(slide as usize))
    }

    pub fn jump(&mut self, slide: u32, step: u32) {
        self.inner.jump(to_pos(slide, step));
    }

    /// Animate to `[slide, step]` when it is one click ahead, else jump; `now` in seconds.
    pub fn advance(&mut self, slide: u32, step: u32, now: f64) {
        self.inner.advance(to_pos(slide, step), now);
    }

    pub fn resize(&mut self, width: u32) {
        self.inner.resize(width);
    }

    /// Hand transitions out as `transition: {textures?, layers}` for a GPU to draw.
    #[wasm_bindgen(js_name = setGpuTransitions)]
    pub fn set_gpu_transitions(&mut self, on: bool) {
        self.inner.set_gpu_transitions(on);
    }

    pub fn animating(&self) -> bool {
        self.inner.animating()
    }

    /// `{width, height, rgba?: Uint8ClampedArray, transition?: {textures?: [{width, height, rgba}
    /// | null], layers: [{texture: number | null, color, vertices: Float32Array, indices:
    /// Uint32Array}]}, animating, cues: [{shape, action}]}`
    pub fn frame(&mut self, now: f64) -> Result<JsValue, JsValue> {
        let tick = self.inner.frame(now);
        let o = Object::new();
        let (w, h) = self.inner.size();
        set(&o, "width", w)?;
        set(&o, "height", h)?;
        set(&o, "animating", tick.animating)?;
        if let Some(f) = tick.frame {
            set(&o, "width", f.width)?;
            set(&o, "height", f.height)?;
            set(&o, "rgba", Uint8ClampedArray::from(f.rgba.as_slice()))?;
        }
        if let Some(tr) = tick.transition {
            let t = Object::new();
            if let Some(textures) = tr.textures {
                let list = Array::new();
                for tex in textures {
                    list.push(&match tex {
                        Some(f) => picture(&f)?,
                        None => JsValue::NULL,
                    });
                }
                set(&t, "textures", list)?;
            }
            let layers = Array::new();
            for l in tr.layers {
                let layer = Object::new();
                set(&layer, "texture", l.texture.map(|i| i as f64))?;
                let color: Array = l.color.iter().map(|c| JsValue::from_f64(f64::from(*c))).collect();
                set(&layer, "color", color)?;
                set(&layer, "vertices", Float32Array::from(l.vertices.as_slice()))?;
                set(&layer, "indices", Uint32Array::from(l.indices.as_slice()))?;
                layers.push(&layer);
            }
            set(&t, "layers", layers)?;
            set(&o, "transition", t)?;
        }
        let cues = Array::new();
        for c in tick.cues {
            let cue = Object::new();
            set(&cue, "shape", c.shape.0)?;
            set(&cue, "action", c.action.as_str())?;
            cues.push(&cue);
        }
        set(&o, "cues", cues)?;
        Ok(o.into())
    }

    /// `[{slide, shape, video, contentType, data: Uint8Array, link?, rect: [x, y, w, h],
    /// volume, trimStartMs, trimEndMs}]`, rects as fractions of the slide.
    pub fn media(&self) -> Result<JsValue, JsValue> {
        let out = Array::new();
        for m in self.inner.media() {
            let o = Object::new();
            set(&o, "slide", m.slide as f64)?;
            set(&o, "shape", m.shape.0)?;
            set(&o, "video", m.video)?;
            set(&o, "contentType", m.content_type.as_str())?;
            set(&o, "data", Uint8Array::from(m.data.as_slice()))?;
            if let Some(link) = &m.link {
                set(&o, "link", link.as_str())?;
            }
            let rect: Array = m.rect.iter().map(|v| JsValue::from_f64(*v)).collect();
            set(&o, "rect", rect)?;
            set(&o, "volume", m.volume)?;
            set(&o, "loop", m.loop_play)?;
            set(&o, "trimStartMs", m.trim_start_ms)?;
            set(&o, "trimEndMs", m.trim_end_ms)?;
            out.push(&o);
        }
        Ok(out.into())
    }
}

fn picture(f: &Frame) -> Result<JsValue, JsValue> {
    let o = Object::new();
    set(&o, "width", f.width)?;
    set(&o, "height", f.height)?;
    set(&o, "rgba", Uint8ClampedArray::from(f.rgba.as_slice()))?;
    Ok(o.into())
}

fn set(o: &Object, key: &str, value: impl Into<JsValue>) -> Result<(), JsValue> {
    Reflect::set(o, &JsValue::from_str(key), &value.into()).map(|_| ())
}

fn to_pos(slide: u32, step: u32) -> Pos {
    Pos { slide: slide as usize, step: step as usize }
}

fn from_pos(p: Pos) -> Vec<u32> {
    vec![u32::try_from(p.slide).unwrap_or(u32::MAX), u32::try_from(p.step).unwrap_or(u32::MAX)]
}
