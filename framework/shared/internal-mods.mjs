// The framework's internal mods' ids (framework/host/internal-mods.mjs; reference-mods.md §0, §2): shipped with the framework, run by the
// Host before the user's mods, never one of the user's installed mods. Shared by the Host and the page's runtime. NO NODE API.
export const INTERNAL_MOD_IDS = Object.freeze(['codexmods.intelligence']);
