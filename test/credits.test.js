'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../src/credits');

const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
const pane = html.match(/<section id="pane-credits"[\s\S]*?<\/section>/)[0];

test('Credits links only to pages the main process knows, each opened by name', () => {
  const links = [...pane.matchAll(/<a\b[^>]*>/g)].map(([tag]) => ({
    name: tag.match(/data-credit="([^"]+)"/)?.[1], href: tag.match(/href="([^"]+)"/)?.[1] }));
  assert.ok(links.length >= 3);
  for (const { name, href } of links) {
    assert.ok(name && Object.hasOwn(credits, name), `${href} has no known data-credit`);
    assert.equal(href, credits[name], `${name}'s href is the page it opens`);
  }
  for (const [name, url] of Object.entries(credits)) {
    assert.match(url, /^https:\/\//, name);
    assert.ok(links.some(link => link.name === name), `${name} is not linked from Credits`);
  }
  assert.ok(Object.isFrozen(credits));
});

test('Credits names the Eclipse team, the Eclipse texture pack and the Brazilian Portuguese translation', () => {
  for (const who of ['The Eclipse team', 'iZePlayzYT', 'Traduções PKG']) assert.ok(pane.includes(who), who);
  assert.match(html, /id="tab-credits"[^>]*aria-controls="pane-credits"/);
});

test('the main process opens credits by name and nothing else', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('open-credit', \(_event, name\) => Object\.hasOwn\(CREDITS, name\) \? shell\.openExternal\(CREDITS\[name\]\) : undefined\)/);
});
