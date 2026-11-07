// Integrated and background terminal data, and the CommandRun link set after the core maps the item.
import { terminalData } from '../../areas/terminals.mjs';
import { refs } from '../../map.mjs';

export function produced() {
  const thread = refs.thread('t'), project = refs.project('p');
  const agent = terminalData({ id: 'command', threadId: 't', cwd: '/repo' }, { title: 'make', project, thread, agent: true });
  return [
    terminalData({ id: 'session', cwd: '/repo', shell: 'zsh' }, { title: 'repo', project, thread }),
    terminalData({ id: 'home', cwd: null, shell: null }, { title: 'Terminal 2', project: null, thread: null }),
    agent,
    { ref: refs.item('CodexCommandRun', 't', 'command'), links: { terminal: agent.ref } },
  ];
}
