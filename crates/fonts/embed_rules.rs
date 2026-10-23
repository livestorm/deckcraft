// Which craft-fonts faces a build compiles in. Shared by build.rs (`include!`) and the crate's
// tests (`#[path]`), so the rule is tested.

/// Does a build embed this craft-fonts face? Native builds embed them all. Web builds keep Inter
/// and BIZ UDPGothic Regular, to stay within the web size budget. `CRAFT_FONTS_EMBED=none` (the
/// browser player, which fetches each deck's fonts) embeds none.
pub fn embeds(family: &str, style: &str, wasm: bool, embed: Option<&str>) -> bool {
    if embed == Some("none") {
        return false;
    }
    !wasm || matches!((family, style), ("BIZ UDPGothic", "Regular") | ("Inter", "Regular" | "Bold" | "Variable"))
}
