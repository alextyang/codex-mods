// ctx.events → the Bus. emit only for mod/<ownId>/...
import { CodexModsError } from '../../../sdk/errors.mjs';

export function createEventsNs({ bus }) {
  return {
    calls: {
      emit(scope, topic, data) {
        const own = `mod/${scope.state.id}/`;
        if (typeof topic !== 'string' || !topic.startsWith(own) || topic.length === own.length || topic.includes('*')) {
          throw new CodexModsError('Denied', `a mod may only emit topics under ${own}`);
        }
        if (data === undefined) data = null;
        bus.publish(topic, data);
      },
      state(scope, topic) {
        if (typeof topic !== 'string') throw new CodexModsError('Invalid', 'topic must be a string');
        const v = bus.state(topic);
        return v === undefined ? undefined : structuredClone(v);
      },
    },
    subs: {
      on(scope, [topic, opts], emit) {
        if (typeof topic !== 'string') throw new CodexModsError('Invalid', 'topic must be a string');
        const replay = opts?.replay === 'state' ? 'state' : undefined;
        return bus.subscribe(topic, (data, t) => emit({ topic: t, data }), { replay });
      },
    },
  };
}
