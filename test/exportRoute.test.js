process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'export-route-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../lib/db');
const { createSongsRouter } = require('../routes/songs');

const insertUser = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', ?)");
const insertSong = db.prepare(
  'INSERT INTO songs (user_id, title, artist, content, visibility, status, bpm) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

const alice = Number(insertUser.run('alice', 'user').lastInsertRowid);
const admin = Number(insertUser.run('admin', 'admin').lastInsertRowid);
insertSong.run(alice, 'zebra', 'B', '{title: zebra}\n[G]z', 'private', 'active', 90);
insertSong.run(alice, 'Alpha', 'A', '{title: Alpha}\n[C]a', 'public', 'active', 120);
insertSong.run(admin, 'Hidden', '', '{title: Hidden}\n[D]h', 'private', 'active', null);
insertSong.run(alice, 'Pending', '', '{title: Pending}\n[E]p', 'public', 'pending', null);

const app = express();
app.use('/api', createSongsRouter({
  withSkipGlobal: () => (_req, _res, next) => next(),
  exportLimiter: (_req, _res, next) => next(),
}));

let server;
let baseUrl;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
test.after(() => new Promise((resolve) => server.close(resolve)));

function auth(id) {
  return { Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}` };
}

test('JSON export requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/songs/export?format=json`);
  assert.equal(response.status, 401);
});

test('JSON export returns ordered PDF fields using regular-user visibility rules', async () => {
  const response = await fetch(`${baseUrl}/api/songs/export?format=json`, { headers: auth(alice) });
  assert.equal(response.status, 200);
  const { songs } = await response.json();
  assert.deepEqual(songs.map((song) => song.title), ['Alpha', 'zebra']);
  assert.deepEqual(Object.keys(songs[0]), ['id', 'title', 'artist', 'content', 'bpm']);
  assert.equal(songs[0].bpm, 120);
});

test('admin JSON export includes every active song', async () => {
  const response = await fetch(`${baseUrl}/api/songs/export?format=json`, { headers: auth(admin) });
  const { songs } = await response.json();
  assert.deepEqual(songs.map((song) => song.title), ['Alpha', 'Hidden', 'zebra']);
});

test('default export remains a ZIP attachment', async () => {
  const response = await fetch(`${baseUrl}/api/songs/export`, { headers: auth(alice) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /chordvault-export-\d{4}-\d{2}-\d{2}\.zip/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});
