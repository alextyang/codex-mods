// A mod's images on the framework's pages (docs/design/framework-ui.md F6): asked for when shown, from `Mod.image`, which gives a data URL rather than keeping one in its state; a frame
// until it comes, and if it cannot. NO NODE API.

/** @param {{ R: object, kit: object, invoke: (ref: object, op: string, args?: unknown[]) => Promise<object> }} o */
export function createModMedia(o) {
  const { R, kit } = o;
  const e = R.createElement;

  /** The image `id` of the mod `mod` (a ref), or null while there is none. */
  function useImage(mod, id) {
    const [url, setUrl] = R.useState(null);
    const modId = mod?.id;
    R.useEffect(() => {
      let live = true;
      if (modId && id) Promise.resolve(o.invoke(mod, 'image', [id])).then((out) => { if (live && typeof out?.value === 'string') setUrl(out.value); }, () => {});
      return () => { live = false; };
    }, [modId, id]);
    return url;
  }

  function ModMedia({ mod, item }) {
    const url = useImage(mod, item.id);
    return e('figure', { className: 'cmk-media', 'data-media': item.id },
      e('div', { className: 'cmk-media-frame', style: { aspectRatio: item.aspect ?? '16 / 9' } }, url ? e('img', { src: url, alt: typeof item.caption === 'string' ? item.caption : '' }) : e(kit.Glyph, { name: 'image', size: 20 })),
      item.caption ? e('figcaption', { className: 'cmk-media-caption' }, item.caption) : null);
  }
  return { ModMedia, useImage };
}
