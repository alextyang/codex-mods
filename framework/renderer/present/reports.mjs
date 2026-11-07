// The framework's own presentations, reported read-only (docs/design/systems.md E6 decision 6, E6.5): its Settings pages, their rows, its
// Dialogs, the band's lines and the composer pickers are Presentation instances like the app's, through the same page registry
// (instances.mjs), with records the framework's components put while they are shown, not kernel mounts. Their bindings are the framework's
// alone: not in addresses.json, so never armed by the kernel, never a rule's target, never in the feature log; no rule applies to them
// (the runtime's facts), and their subjects are the framework's, so the policy keeps every mod to reading them. NO NODE API.

/** The presentation types the framework reports. */
export const REPORTED = Object.freeze(['SettingsPage', 'SettingsRow', 'Dialog', 'NotificationBanner', 'ComposerPicker', 'DetailView', 'Page', 'Region']);

/** One binding per type: its subject and place are the record's own (the component that puts it knows them). */
export const FRAMEWORK_BINDINGS = Object.freeze(REPORTED.map((type) => Object.freeze({
  id: `framework:${type}`, presentation: type, framework: true,
  subject: (props) => props?.subject ?? null,
  place: (props) => props?.place ?? {},
})));

/**
 * A component that renders nothing and reports one presentation while it is mounted: `type`, `subject` (a graph ref), `place`
 * (`{ in, via?, on?, slot }`). Without the runtime's reporter (`ctx.report`, absent in a window with no registry) it does nothing.
 * @param {object} R  the app's React
 * @param {{ report?: { put(rec: object): void, remove(rec: object): void } }} ctx
 */
export function createReport(R, ctx) {
  return function Report({ type, subject, place }) {
    const key = subject && REPORTED.includes(type) ? JSON.stringify([type, subject.type, subject.provider, subject.id, place ?? {}]) : '';
    R.useEffect(() => {
      const reporter = ctx?.report;
      if (!key || !reporter) return undefined;
      const rec = { binding: `framework:${type}`, props: { subject: { type: subject.type, provider: subject.provider, id: subject.id }, place: place ?? {} } };
      reporter.put(rec);
      return () => reporter.remove(rec);
    }, [key]);
    return null;
  };
}
