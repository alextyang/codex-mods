// The setup app's Dock step: the Dock's preferences read and written without loss, the copy put in ChatGPT's place or beside it, and
// uninstall putting back exactly what was there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlist, writePlist, get } from '../plist.mjs';
import { placeCopy, removeCopy, indexOf, tilePath } from '../dock.mjs';

const tile = (path, label, extra = '') => `
		<dict>
			<key>GUID</key>
			<integer>1234</integer>
			<key>tile-data</key>
			<dict>
				<key>book</key>
				<data>
				Ym9va2RhdGE=
				</data>
				<key>bundle-identifier</key>
				<string>com.example.${label}</string>
				<key>file-data</key>
				<dict>
					<key>_CFURLString</key>
					<string>file://${encodeURI(path)}/</string>
					<key>_CFURLStringType</key>
					<integer>15</integer>
				</dict>
				<key>file-label</key>
				<string>${label}</string>
				<key>file-mod-date</key>
				<integer>3880000000</integer>${extra}
			</dict>
			<key>tile-type</key>
			<string>file-tile</string>
		</dict>`;
const DOCK = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>autohide</key>
	<false/>
	<key>magnification</key>
	<true/>
	<key>mod-count</key>
	<integer>42</integer>
	<key>tilesize</key>
	<real>48.5</real>
	<key>lastShowIndicatorTime</key>
	<date>2026-11-07T12:00:00Z</date>
	<key>persistent-apps</key>
	<array>${tile('/System/Applications/Mail.app', 'Mail')}${tile('/Applications/ChatGPT.app', 'ChatGPT', '\n\t\t\t\t<key>note</key>\n\t\t\t\t<string>Tom &amp; Jerry &lt;3</string>')}${tile('/Applications/Safari.app', 'Safari')}
	</array>
	<key>persistent-others</key>
	<array/>
	<key>empty</key>
	<string></string>
</dict>
</plist>
`;
const COPY = '/Users/me/Applications/ChatGPT Mods.app';
const CHATGPT = '/Applications/ChatGPT.app';
const apps = (d) => get(d, 'persistent-apps').v.map(tilePath);

test('a plist is read and written without loss: every kind of value, entities, empty containers and strings, order', () => {
  const d = parsePlist(DOCK);
  assert.deepEqual(parsePlist(writePlist(d)), d, 'what is written reads back the same');
  assert.equal(get(d, 'tilesize').v, '48.5');
  assert.equal(get(d, 'lastShowIndicatorTime').v, '2026-11-07T12:00:00Z');
  assert.equal(get(get(get(d, 'persistent-apps').v[1], 'tile-data'), 'note').v, 'Tom & Jerry <3');
  assert.match(writePlist(d), /<string>Tom &amp; Jerry &lt;3<\/string>/);
  assert.deepEqual(get(d, 'persistent-others'), { t: 'array', v: [] });
  assert.equal(get(d, 'empty').v, '');
  assert.deepEqual(d.v.map(([k]) => k), ['autohide', 'magnification', 'mod-count', 'tilesize', 'lastShowIndicatorTime', 'persistent-apps', 'persistent-others', 'empty']);
  for (const bad of ['', '<plist><dict><string>x</string></dict></plist>', '<plist><dict><key>a</key>', '<plist><foo/></plist>']) assert.throws(() => parsePlist(bad), bad);
});

test('everyday use: the copy takes ChatGPT\'s place, with its own file, name and bundle id and no bookmark; uninstall puts ChatGPT\'s own tile back', () => {
  const d = parsePlist(DOCK);
  const { dock, record } = placeCopy(d, { copy: COPY, chatgpt: CHATGPT, label: 'ChatGPT Mods', bundleId: 'dev.codexmods.app', replace: true });
  assert.deepEqual(apps(dock), ['/System/Applications/Mail.app', COPY, '/Applications/Safari.app']);
  const data = get(get(dock, 'persistent-apps').v[1], 'tile-data');
  assert.equal(get(get(data, 'file-data'), '_CFURLString').v, 'file:///Users/me/Applications/ChatGPT%20Mods.app/');
  assert.equal(get(data, 'file-label').v, 'ChatGPT Mods');
  assert.equal(get(data, 'bundle-identifier').v, 'dev.codexmods.app');
  assert.equal(get(data, 'book'), undefined, 'the Dock goes by the path, so a rebuilt copy keeps its tile');
  assert.equal(get(data, 'file-mod-date'), undefined);
  assert.deepEqual(apps(d), ['/System/Applications/Mail.app', CHATGPT, '/Applications/Safari.app'], 'what it was given is not changed');
  assert.equal(placeCopy(dock, { copy: COPY, chatgpt: CHATGPT, label: 'x', replace: true }), null, 'already there: nothing to do');
  const back = removeCopy(dock, { copy: COPY, chatgpt: CHATGPT, record: JSON.parse(JSON.stringify(record)) });
  assert.deepEqual(back, d, 'exactly what was there');
  assert.equal(removeCopy(back, { copy: COPY, chatgpt: CHATGPT, record }), null, 'no copy in the Dock: nothing to do');
});

test('to try it: the copy goes beside ChatGPT, or at the end without it; uninstall takes only its tile away; ChatGPT added back meanwhile is not doubled', () => {
  const d = parsePlist(DOCK);
  const placed = placeCopy(d, { copy: COPY, chatgpt: CHATGPT, label: 'ChatGPT Mods', replace: false });
  assert.deepEqual(apps(placed.dock), ['/System/Applications/Mail.app', CHATGPT, COPY, '/Applications/Safari.app']);
  assert.deepEqual(placed.record, {});
  assert.deepEqual(apps(removeCopy(placed.dock, { copy: COPY, chatgpt: CHATGPT, record: placed.record })), apps(d));
  assert.equal(placeCopy(d, { copy: CHATGPT, chatgpt: '/nowhere', label: 'x', replace: false }), null, 'an app already in the Dock is never added twice');
  assert.equal(indexOf(d, CHATGPT), 1);
  const replaced = placeCopy(d, { copy: COPY, chatgpt: CHATGPT, label: 'ChatGPT Mods', replace: true });
  const readded = placeCopy(replaced.dock, { copy: CHATGPT, chatgpt: '/Applications/Safari.app', label: 'ChatGPT', replace: false }).dock;
  assert.deepEqual(apps(removeCopy(readded, { copy: COPY, chatgpt: CHATGPT, record: replaced.record })), ['/System/Applications/Mail.app', '/Applications/Safari.app', CHATGPT], 'ChatGPT is already back: the copy\'s tile just goes');
  const without = parsePlist(DOCK.replace(tile('/Applications/ChatGPT.app', 'ChatGPT', '\n\t\t\t\t<key>note</key>\n\t\t\t\t<string>Tom &amp; Jerry &lt;3</string>'), ''));
  assert.deepEqual(apps(placeCopy(without, { copy: COPY, chatgpt: CHATGPT, label: 'ChatGPT Mods', replace: true }).dock).at(-1), COPY, 'no ChatGPT tile: at the end');
  const empty = placeCopy(parsePlist('<plist><dict><key>persistent-apps</key><array/></dict></plist>'), { copy: COPY, chatgpt: CHATGPT, label: 'ChatGPT Mods', replace: true });
  assert.deepEqual(apps(empty.dock), [COPY], 'a Dock with no apps gets a plain tile');
  assert.deepEqual(empty.record, {}, 'and uninstall takes it away');
});
