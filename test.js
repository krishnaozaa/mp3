/*
 * Thorough test suite for the MP3 API: checks every rule in README.md
 * (validation, status codes, check order, two-way references, query params).
 *
 *   node test.js                                  spin up an in-memory MongoDB (default)
 *   node test.js --atlas                          run against MONGODB_URI from .env, cleaning up after
 *   BASE_URL=https://my-mp3.onrender.com node test.js   run against a deployed API
 *
 * Exits 0 only if every check passes.
 */
'use strict';

const MODE = process.env.BASE_URL ? 'remote' : process.argv.includes('--atlas') ? 'atlas' : 'memory';
const PORT = process.env.TEST_PORT || 3987;
const OWNS_DB = MODE !== 'remote';

let mongoose, mem, BASE, User, Task;

async function boot() {
    if (MODE === 'remote') {
        BASE = process.env.BASE_URL.replace(/\/+$/, '') + '/api';
        return;
    }
    if (MODE === 'memory') {
        const { MongoMemoryServer } = require('mongodb-memory-server');
        mem = await MongoMemoryServer.create();
        process.env.MONGODB_URI = mem.getUri('mp3_test');
    } else {
        require('dotenv').config();
        if (!process.env.MONGODB_URI || process.env.MONGODB_URI.includes('<')) {
            throw new Error('MONGODB_URI is not filled in in .env');
        }
    }
    process.env.PORT = String(PORT);
    require('./server'); // the real app, including its unknown-route and JSON-error handlers
    mongoose = require('mongoose');
    User = require('./models/user');
    Task = require('./models/task');
    await mongoose.connection.asPromise();
    BASE = `http://127.0.0.1:${PORT}/api`;
}

async function shutdown() {
    if (!OWNS_DB) return;
    await reset();
    await mongoose.disconnect();
    if (mem) await mem.stop();
}

// ---------------------------------------------------------------- http helper

async function req(method, path, body, { rawBody = false, contentType } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers['Content-Type'] = contentType || 'application/json';
        opts.body = rawBody ? body : JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text, data: json && json.data };
}

const GET = (p) => req('GET', p);
const DEL = (p) => req('DELETE', p);

// ---------------------------------------------------------------- assertions

let currentTest = '';
let checks = 0;
const failures = [];

function check(cond, label, detail) {
    checks++;
    if (!cond) failures.push({ test: currentTest, label, detail });
    return !!cond;
}
function eq(actual, expected, label) {
    return check(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function eqSet(actual, expected, label) {
    const a = [...(actual || [])].map(String).sort();
    const b = [...expected].map(String).sort();
    return check(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
// Every response, success or error, must be {message: <string>, data: ...}
function shape(r, label) {
    check(r.json !== null, `${label}: response is JSON`, r.text.slice(0, 120));
    if (!r.json) return;
    check(typeof r.json.message === 'string' && r.json.message.length > 0, `${label}: has a human readable message`, JSON.stringify(r.json.message));
    check('data' in r.json, `${label}: has a data field`);
    if (r.status >= 400) {
        const m = JSON.stringify(r.json.message);
        check(!/mongo|mongoose|ValidationError|CastError|E11000E?/i.test(m), `${label}: message does not leak Mongoose internals`, m);
    }
}
function status(r, want, label) {
    shape(r, label);
    return eq(r.status, want, `${label}: status`);
}

// ---------------------------------------------------------------- fixtures

let seq = 0;
const stamp = Date.now().toString(36);
const email = () => `mp3test_${stamp}_${++seq}@illinois.edu`;
const FUTURE = '2026-12-01T00:00:00.000Z';

async function mkUser(over = {}) {
    const r = await req('POST', '/users', { name: 'User' + ++seq, email: email(), ...over });
    if (r.status !== 201) throw new Error(`fixture user failed: ${r.status} ${r.text}`);
    return r.data;
}
async function mkTask(over = {}) {
    const r = await req('POST', '/tasks', { name: 'Task' + ++seq, deadline: FUTURE, ...over });
    if (r.status !== 201) throw new Error(`fixture task failed: ${r.status} ${r.text}`);
    return r.data;
}
const getUser = async (id) => (await GET(`/users/${id}`)).data;
const getTask = async (id) => (await GET(`/tasks/${id}`)).data;

async function reset() {
    if (!OWNS_DB) return;
    await mongoose.connection.collection('users').deleteMany({});
    await mongoose.connection.collection('tasks').deleteMany({});
}

// Full database state, for "nothing may be changed when a request fails"
async function snapshot() {
    const u = await GET('/users?sort={"email":1}&limit=10000');
    const t = await GET('/tasks?sort={"name":1}&limit=10000');
    return JSON.stringify([u.data, t.data]);
}
async function expectNoWrite(label, fn) {
    const before = await snapshot();
    const r = await fn();
    const after = await snapshot();
    check(before === after, `${label}: database unchanged after the failed request`);
    return r;
}

const MISSING_ID = '000000000000000000000000'; // valid ObjectId format, never exists
const BAD_ID = 'not-an-object-id';

// ---------------------------------------------------------------- tests

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });

// --- response format and defaults ------------------------------------------

test('POST /users sets sensible defaults', async () => {
    const r = await req('POST', '/users', { name: 'Ada Lovelace', email: email() });
    status(r, 201, 'POST /users');
    eq(r.data.name, 'Ada Lovelace', 'name stored');
    eqSet(r.data.pendingTasks, [], 'pendingTasks defaults to empty');
    check(!!r.data._id, 'has an _id');
    check(!!r.data.dateCreated && !isNaN(Date.parse(r.data.dateCreated)), 'dateCreated set by the server');
});

test('POST /tasks sets sensible defaults', async () => {
    const r = await req('POST', '/tasks', { name: 'Write MP3', deadline: FUTURE });
    status(r, 201, 'POST /tasks');
    eq(r.data.description, '', 'description defaults to ""');
    eq(r.data.completed, false, 'completed defaults to false');
    eq(r.data.assignedUser, '', 'assignedUser defaults to ""');
    eq(r.data.assignedUserName, 'unassigned', 'assignedUserName defaults to "unassigned"');
    check(!!r.data.dateCreated && !isNaN(Date.parse(r.data.dateCreated)), 'dateCreated set by the server');
});

// --- validation: 400s ------------------------------------------------------

test('POST /users rejects missing or badly typed fields', async () => {
    await expectNoWrite('no name', async () => {
        const r = await req('POST', '/users', { email: email() });
        status(r, 400, 'POST /users without name');
        return r;
    });
    status(await req('POST', '/users', { name: 'No Email' }), 400, 'POST /users without email');
    status(await req('POST', '/users', { name: '', email: email() }), 400, 'POST /users with empty name');
    status(await req('POST', '/users', { name: 'X', email: '' }), 400, 'POST /users with empty email');
    status(await req('POST', '/users', { name: 42, email: email() }), 400, 'POST /users with numeric name');
    status(await req('POST', '/users', { name: 'X', email: { a: 1 } }), 400, 'POST /users with object email');
    status(await req('POST', '/users', {}), 400, 'POST /users with empty body');
});

test('POST /users rejects duplicate emails', async () => {
    const e = email();
    status(await req('POST', '/users', { name: 'First', email: e }), 201, 'first user with the email');
    await expectNoWrite('duplicate email', async () => {
        const r = await req('POST', '/users', { name: 'Second', email: e });
        status(r, 400, 'POST /users with an email already in use');
        return r;
    });
});

test('PUT /users rejects an email used by another user', async () => {
    const a = await mkUser();
    const b = await mkUser();
    status(await req('PUT', `/users/${b._id}`, { name: b.name, email: a.email }), 400, "PUT /users taking another user's email");
    // Keeping your own email must still be allowed
    status(await req('PUT', `/users/${b._id}`, { name: 'Renamed', email: b.email }), 200, 'PUT /users keeping its own email');
});

test('POST /tasks rejects missing or badly typed fields', async () => {
    status(await req('POST', '/tasks', { deadline: FUTURE }), 400, 'POST /tasks without name');
    status(await req('POST', '/tasks', { name: 'No deadline' }), 400, 'POST /tasks without deadline');
    status(await req('POST', '/tasks', { name: '', deadline: FUTURE }), 400, 'POST /tasks with empty name');
    status(await req('POST', '/tasks', { name: 'X', deadline: '' }), 400, 'POST /tasks with empty deadline');
    status(await req('POST', '/tasks', { name: 'X', deadline: 'not a date' }), 400, 'POST /tasks with unparseable deadline');
    status(await req('POST', '/tasks', { name: 'X', deadline: true }), 400, 'POST /tasks with boolean deadline');
    status(await req('POST', '/tasks', { name: 'X', deadline: FUTURE, completed: 'yes' }), 400, 'POST /tasks with non-boolean completed');
    status(await req('POST', '/tasks', { name: 'X', deadline: FUTURE, description: 5 }), 400, 'POST /tasks with numeric description');
    status(await req('POST', '/tasks', {}), 400, 'POST /tasks with empty body');
});

test('references with a bad id format are 400, missing references are 404', async () => {
    status(await req('POST', '/users', { name: 'X', email: email(), pendingTasks: [BAD_ID] }), 400, 'pendingTasks with a malformed id');
    status(await req('POST', '/users', { name: 'X', email: email(), pendingTasks: 'nope' }), 400, 'pendingTasks that is not a list');
    status(await req('POST', '/users', { name: 'X', email: email(), pendingTasks: [1, 2] }), 400, 'pendingTasks of numbers');
    await expectNoWrite('pendingTasks referencing a missing task', async () => {
        const r = await req('POST', '/users', { name: 'X', email: email(), pendingTasks: [MISSING_ID] });
        status(r, 404, 'pendingTasks with a valid but unused task id');
        return r;
    });
    status(await req('POST', '/tasks', { name: 'X', deadline: FUTURE, assignedUser: BAD_ID }), 400, 'assignedUser with a malformed id');
    await expectNoWrite('assignedUser referencing a missing user', async () => {
        const r = await req('POST', '/tasks', { name: 'X', deadline: FUTURE, assignedUser: MISSING_ID });
        status(r, 404, 'assignedUser with a valid but unused user id');
        return r;
    });
});

test('a completed task cannot be in pendingTasks', async () => {
    const done = await mkTask({ completed: true });
    status(await req('POST', '/users', { name: 'X', email: email(), pendingTasks: [done._id] }), 400, 'POST /users with a completed task pending');
    const u = await mkUser();
    status(await req('PUT', `/users/${u._id}`, { name: u.name, email: u.email, pendingTasks: [done._id] }), 400, 'PUT /users with a completed task pending');
});

test('assignedUserName must match assignedUser', async () => {
    const u = await mkUser({ name: 'Real Name' });
    status(await req('POST', '/tasks', { name: 'X', deadline: FUTURE, assignedUser: u._id, assignedUserName: 'Wrong Name' }), 400, 'POST /tasks with a mismatched assignedUserName');
    status(await req('POST', '/tasks', { name: 'X', deadline: FUTURE, assignedUserName: 'Somebody' }), 400, 'POST /tasks naming a user with no assignedUser');
    // Omitting assignedUserName is allowed: the server fills it in
    const r = await req('POST', '/tasks', { name: 'X', deadline: FUTURE, assignedUser: u._id });
    status(r, 201, 'POST /tasks with assignedUser and no assignedUserName');
    eq(r.data.assignedUserName, 'Real Name', 'assignedUserName filled in from the user');
    // The matching name is accepted
    status(await req('POST', '/tasks', { name: 'Y', deadline: FUTURE, assignedUser: u._id, assignedUserName: 'Real Name' }), 201, 'POST /tasks with a matching assignedUserName');
});

// --- 404s -------------------------------------------------------------------

test('GET/PUT/DELETE on a missing id are 404', async () => {
    for (const id of [MISSING_ID, BAD_ID]) {
        const what = id === BAD_ID ? 'an invalid ObjectId' : 'an unused id';
        status(await GET(`/users/${id}`), 404, `GET /users/${what}`);
        status(await GET(`/tasks/${id}`), 404, `GET /tasks/${what}`);
        status(await req('PUT', `/users/${id}`, { name: 'X', email: email() }), 404, `PUT /users/${what}`);
        status(await req('PUT', `/tasks/${id}`, { name: 'X', deadline: FUTURE }), 404, `PUT /tasks/${what}`);
        status(await DEL(`/users/${id}`), 404, `DELETE /users/${what}`);
        status(await DEL(`/tasks/${id}`), 404, `DELETE /tasks/${what}`);
    }
});

test('unknown endpoints are a JSON 404', async () => {
    const r = await GET('/not-a-real-endpoint');
    status(r, 404, 'GET /api/not-a-real-endpoint');
});

// --- check order: URL 404 -> field 400 -> reference 404 ---------------------

test('the URL id is checked before the body', async () => {
    // Missing resource + invalid body: the URL wins (404, not 400)
    status(await req('PUT', `/users/${MISSING_ID}`, {}), 404, 'PUT missing user with an empty body');
    status(await req('PUT', `/users/${BAD_ID}`, {}), 404, 'PUT invalid user id with an empty body');
    status(await req('PUT', `/tasks/${MISSING_ID}`, {}), 404, 'PUT missing task with an empty body');
    status(await req('PUT', `/tasks/${BAD_ID}`, { name: 5 }), 404, 'PUT invalid task id with a bad field');
    // Missing resource + a bad reference in the body: still the URL
    status(await req('PUT', `/users/${MISSING_ID}`, { name: 'X', email: email(), pendingTasks: [MISSING_ID] }), 404, 'PUT missing user referencing a missing task');
    status(await req('PUT', `/tasks/${MISSING_ID}`, { name: 'X', deadline: FUTURE, assignedUser: MISSING_ID }), 404, 'PUT missing task referencing a missing user');
});

test('field format is checked before references exist', async () => {
    // Bad field + a reference that does not exist: the field wins (400, not 404)
    status(await req('POST', '/users', { email: email(), pendingTasks: [MISSING_ID] }), 400, 'POST /users with no name and a missing task');
    status(await req('POST', '/tasks', { name: 'X', deadline: 'nonsense', assignedUser: MISSING_ID }), 400, 'POST /tasks with a bad deadline and a missing user');
    const u = await mkUser();
    status(await req('PUT', `/users/${u._id}`, { name: '', email: u.email, pendingTasks: [MISSING_ID] }), 400, 'PUT /users with an empty name and a missing task');
});

test('a failed request writes nothing, even when it is partly valid', async () => {
    const u = await mkUser();
    const t = await mkTask();
    await expectNoWrite('one good and one missing task in pendingTasks', () =>
        req('PUT', `/users/${u._id}`, { name: u.name, email: u.email, pendingTasks: [t._id, MISSING_ID] })
    );
    eqSet((await getUser(u._id)).pendingTasks, [], 'the valid task was not assigned by the failed request');
    eq((await getTask(t._id)).assignedUser, '', 'the valid task is still unassigned');
});

// --- malformed JSON ---------------------------------------------------------

test('a malformed JSON body is a 400', async () => {
    const r = await req('POST', '/users', '{"name": "X", "email":', { rawBody: true });
    status(r, 400, 'POST /users with truncated JSON');
    const r2 = await req('PUT', `/tasks/${MISSING_ID}`, 'not json at all', { rawBody: true });
    check(r2.status === 400 || r2.status === 404, 'PUT with a malformed body is 400 or 404', `got ${r2.status}`);
});

// --- two-way references: PUT /users ---------------------------------------

test('PUT /users assigns tasks added to pendingTasks', async () => {
    const u = await mkUser({ name: 'Owner' });
    const t = await mkTask();
    const r = await req('PUT', `/users/${u._id}`, { name: 'Owner', email: u.email, pendingTasks: [t._id] });
    status(r, 200, 'PUT /users adding a task');
    eqSet(r.data.pendingTasks, [t._id], 'pendingTasks in the response');
    const task = await getTask(t._id);
    eq(task.assignedUser, u._id, 'task.assignedUser points at the user');
    eq(task.assignedUserName, 'Owner', 'task.assignedUserName is the user name');
});

test('PUT /users unassigns tasks dropped from pendingTasks', async () => {
    const u = await mkUser();
    const t1 = await mkTask();
    const t2 = await mkTask();
    await req('PUT', `/users/${u._id}`, { name: u.name, email: u.email, pendingTasks: [t1._id, t2._id] });
    const r = await req('PUT', `/users/${u._id}`, { name: u.name, email: u.email, pendingTasks: [t1._id] });
    status(r, 200, 'PUT /users dropping a task');
    eqSet(r.data.pendingTasks, [t1._id], 'only the kept task remains pending');
    const dropped = await getTask(t2._id);
    eq(dropped.assignedUser, '', 'dropped task assignedUser is ""');
    eq(dropped.assignedUserName, 'unassigned', 'dropped task assignedUserName is "unassigned"');
    eq((await getTask(t1._id)).assignedUser, u._id, 'kept task is still assigned');
});

test('PUT /users with no pendingTasks empties the list', async () => {
    const u = await mkUser();
    const t = await mkTask();
    await req('PUT', `/users/${u._id}`, { name: u.name, email: u.email, pendingTasks: [t._id] });
    const r = await req('PUT', `/users/${u._id}`, { name: u.name, email: u.email });
    status(r, 200, 'PUT /users omitting pendingTasks');
    eqSet(r.data.pendingTasks, [], 'pendingTasks is now empty');
    const task = await getTask(t._id);
    eq(task.assignedUser, '', 'the task was unassigned');
    eq(task.assignedUserName, 'unassigned', 'the task shows as unassigned');
});

test('PUT /users moves a task away from another user', async () => {
    const a = await mkUser({ name: 'Alice' });
    const b = await mkUser({ name: 'Bob' });
    const t = await mkTask();
    await req('PUT', `/users/${a._id}`, { name: 'Alice', email: a.email, pendingTasks: [t._id] });
    const r = await req('PUT', `/users/${b._id}`, { name: 'Bob', email: b.email, pendingTasks: [t._id] });
    status(r, 200, 'PUT /users claiming another user task');
    eqSet((await getUser(a._id)).pendingTasks, [], 'the task left the previous user pendingTasks');
    eqSet((await getUser(b._id)).pendingTasks, [t._id], 'the task is in the new user pendingTasks');
    const task = await getTask(t._id);
    eq(task.assignedUser, b._id, 'task.assignedUser is the new user');
    eq(task.assignedUserName, 'Bob', 'task.assignedUserName is the new user name');
});

test('renaming a user updates assignedUserName, completed tasks too', async () => {
    const u = await mkUser({ name: 'Old Name' });
    const pending = await mkTask({ assignedUser: u._id });
    const done = await mkTask({ assignedUser: u._id, completed: true });
    eqSet((await getUser(u._id)).pendingTasks, [pending._id], 'only the pending task is in pendingTasks');

    const r = await req('PUT', `/users/${u._id}`, { name: 'New Name', email: u.email, pendingTasks: [pending._id] });
    status(r, 200, 'PUT /users renaming the user');
    eq((await getTask(pending._id)).assignedUserName, 'New Name', 'pending task assignedUserName renamed');

    const after = await getTask(done._id);
    eq(after.assignedUserName, 'New Name', 'completed task assignedUserName renamed');
    eq(after.assignedUser, u._id, 'completed task is still assigned to the user');
    eqSet((await getUser(u._id)).pendingTasks, [pending._id], 'the completed task stays out of pendingTasks');
});

test('PUT /users does not change dateCreated', async () => {
    const u = await mkUser();
    const r = await req('PUT', `/users/${u._id}`, { name: 'Changed', email: u.email });
    status(r, 200, 'PUT /users');
    eq(new Date(r.data.dateCreated).getTime(), new Date(u.dateCreated).getTime(), 'dateCreated unchanged');
});

test('POST /users with pendingTasks follows the same rules', async () => {
    const a = await mkUser({ name: 'Alice' });
    const t = await mkTask({ assignedUser: a._id });
    const r = await req('POST', '/users', { name: 'Carol', email: email(), pendingTasks: [t._id] });
    status(r, 201, 'POST /users with pendingTasks');
    eqSet((await getUser(a._id)).pendingTasks, [], 'the task left the previous user');
    const task = await getTask(t._id);
    eq(task.assignedUser, r.data._id, 'the task is assigned to the new user');
    eq(task.assignedUserName, 'Carol', 'assignedUserName is the new user name');
});

// --- two-way references: PUT /tasks ---------------------------------------

test('PUT /tasks assigning a task adds it to pendingTasks', async () => {
    const u = await mkUser({ name: 'Dana' });
    const t = await mkTask();
    const r = await req('PUT', `/tasks/${t._id}`, { name: t.name, deadline: FUTURE, assignedUser: u._id });
    status(r, 200, 'PUT /tasks assigning a user');
    eq(r.data.assignedUser, u._id, 'assignedUser set');
    eq(r.data.assignedUserName, 'Dana', 'assignedUserName filled in');
    eqSet((await getUser(u._id)).pendingTasks, [t._id], 'the task is in the user pendingTasks');
});

test('completing a task removes it from pendingTasks but keeps it assigned', async () => {
    const u = await mkUser({ name: 'Dana' });
    const t = await mkTask({ assignedUser: u._id });
    eqSet((await getUser(u._id)).pendingTasks, [t._id], 'pending to start with');

    const r = await req('PUT', `/tasks/${t._id}`, { name: t.name, deadline: FUTURE, assignedUser: u._id, completed: true });
    status(r, 200, 'PUT /tasks completing it');
    eq(r.data.completed, true, 'completed is true');
    eq(r.data.assignedUser, u._id, 'still assigned to the user');
    eq(r.data.assignedUserName, 'Dana', 'assignedUserName kept');
    eqSet((await getUser(u._id)).pendingTasks, [], 'removed from pendingTasks');
});

test('un-completing an assigned task makes it pending again', async () => {
    const u = await mkUser({ name: 'Dana' });
    const t = await mkTask({ assignedUser: u._id, completed: true });
    eqSet((await getUser(u._id)).pendingTasks, [], 'a completed task starts out not pending');

    const r = await req('PUT', `/tasks/${t._id}`, { name: t.name, deadline: FUTURE, assignedUser: u._id, completed: false });
    status(r, 200, 'PUT /tasks un-completing it');
    eq(r.data.completed, false, 'completed is false');
    eqSet((await getUser(u._id)).pendingTasks, [t._id], 'back in pendingTasks');
});

test('PUT /tasks moving a task between users fixes both pendingTasks', async () => {
    const a = await mkUser({ name: 'Alice' });
    const b = await mkUser({ name: 'Bob' });
    const t = await mkTask({ assignedUser: a._id });
    const r = await req('PUT', `/tasks/${t._id}`, { name: t.name, deadline: FUTURE, assignedUser: b._id, assignedUserName: 'Bob' });
    status(r, 200, 'PUT /tasks reassigning');
    eqSet((await getUser(a._id)).pendingTasks, [], 'removed from the previous user');
    eqSet((await getUser(b._id)).pendingTasks, [t._id], 'added to the new user');
    eq((await getTask(t._id)).assignedUserName, 'Bob', 'assignedUserName updated');
});

test('PUT /tasks with assignedUser "" unassigns the task', async () => {
    const u = await mkUser();
    const t = await mkTask({ assignedUser: u._id });
    const r = await req('PUT', `/tasks/${t._id}`, { name: t.name, deadline: FUTURE, assignedUser: '' });
    status(r, 200, 'PUT /tasks clearing assignedUser');
    eq(r.data.assignedUser, '', 'assignedUser is ""');
    eq(r.data.assignedUserName, 'unassigned', 'assignedUserName is "unassigned"');
    eqSet((await getUser(u._id)).pendingTasks, [], 'removed from the user pendingTasks');
});

test('PUT /tasks omitting assignedUser unassigns the task', async () => {
    const u = await mkUser();
    const t = await mkTask({ assignedUser: u._id });
    const r = await req('PUT', `/tasks/${t._id}`, { name: 'Replaced', deadline: FUTURE });
    status(r, 200, 'PUT /tasks without assignedUser');
    eq(r.data.assignedUser, '', 'assignedUser back to its default');
    eq(r.data.assignedUserName, 'unassigned', 'assignedUserName back to its default');
    eq(r.data.description, '', 'description back to its default');
    eq(r.data.completed, false, 'completed back to its default');
    eqSet((await getUser(u._id)).pendingTasks, [], 'removed from the user pendingTasks');
});

test('PUT /tasks can reassign an already completed task', async () => {
    const a = await mkUser({ name: 'Alice' });
    const b = await mkUser({ name: 'Bob' });
    const t = await mkTask({ assignedUser: a._id, completed: true });
    const r = await req('PUT', `/tasks/${t._id}`, { name: t.name, deadline: FUTURE, completed: true, assignedUser: b._id });
    status(r, 200, 'PUT /tasks reassigning a completed task');
    eq(r.data.assignedUser, b._id, 'assigned to the new user');
    eq(r.data.assignedUserName, 'Bob', 'assignedUserName is the new user');
    eqSet((await getUser(a._id)).pendingTasks, [], 'not pending for the old user');
    eqSet((await getUser(b._id)).pendingTasks, [], 'not pending for the new user either');
});

test('PUT /tasks does not change dateCreated', async () => {
    const t = await mkTask();
    const r = await req('PUT', `/tasks/${t._id}`, { name: 'Changed', deadline: FUTURE });
    status(r, 200, 'PUT /tasks');
    eq(new Date(r.data.dateCreated).getTime(), new Date(t.dateCreated).getTime(), 'dateCreated unchanged');
});

test('POST /tasks with a completed flag is assigned but not pending', async () => {
    const u = await mkUser({ name: 'Dana' });
    const r = await req('POST', '/tasks', { name: 'Done already', deadline: FUTURE, assignedUser: u._id, completed: true });
    status(r, 201, 'POST /tasks completed and assigned');
    eq(r.data.assignedUser, u._id, 'assignedUser set');
    eq(r.data.assignedUserName, 'Dana', 'assignedUserName set');
    eqSet((await getUser(u._id)).pendingTasks, [], 'not added to pendingTasks');
});

// --- deleting ---------------------------------------------------------------

test('DELETE /tasks/:id removes the task from its user pendingTasks', async () => {
    const u = await mkUser();
    const t = await mkTask({ assignedUser: u._id });
    const r = await DEL(`/tasks/${t._id}`);
    check(r.status === 200 || r.status === 204, 'DELETE /tasks status is 200 or 204', `got ${r.status}`);
    if (r.status !== 204) shape(r, 'DELETE /tasks');
    status(await GET(`/tasks/${t._id}`), 404, 'GET the deleted task');
    eqSet((await getUser(u._id)).pendingTasks, [], 'the task is gone from pendingTasks');
    status(await DEL(`/tasks/${t._id}`), 404, 'DELETE the same task twice');
});

test('DELETE /users/:id unassigns all of its tasks, completed ones too', async () => {
    const u = await mkUser({ name: 'Doomed' });
    const pending = await mkTask({ assignedUser: u._id });
    const done = await mkTask({ assignedUser: u._id, completed: true });
    const r = await DEL(`/users/${u._id}`);
    check(r.status === 200 || r.status === 204, 'DELETE /users status is 200 or 204', `got ${r.status}`);
    if (r.status !== 204) shape(r, 'DELETE /users');
    status(await GET(`/users/${u._id}`), 404, 'GET the deleted user');

    for (const [label, t] of [['pending', pending], ['completed', done]]) {
        const after = await getTask(t._id);
        eq(after.assignedUser, '', `${label} task assignedUser is ""`);
        eq(after.assignedUserName, 'unassigned', `${label} task assignedUserName is "unassigned"`);
    }
    status(await DEL(`/users/${u._id}`), 404, 'DELETE the same user twice');
});

// --- query parameters -------------------------------------------------------

test('where filters, and no match is still a 200 with an empty list', async () => {
    const t1 = await mkTask({ name: 'Alpha task' });
    await mkTask({ name: 'Beta task', completed: true });

    const byId = await GET(`/tasks?where={"_id":"${t1._id}"}`);
    status(byId, 200, 'GET /tasks?where by _id');
    eq(byId.data.length, 1, 'one task matched');
    eq(byId.data[0]._id, t1._id, 'the right task');

    const done = await GET('/tasks?where={"completed":true}');
    status(done, 200, 'GET /tasks?where completed');
    check(done.data.every((t) => t.completed === true), 'every result is completed');
    check(done.data.length >= 1, 'at least one completed task');

    const none = await GET('/tasks?where={"name":"definitely-no-such-task-name"}');
    status(none, 200, 'GET /tasks?where with no matches');
    eq(none.data.length, 0, 'empty list, not a 404');

    const inList = await GET(`/tasks?where={"_id":{"$in":["${t1._id}","${MISSING_ID}"]}}`);
    status(inList, 200, 'GET /tasks?where with $in');
    eq(inList.data.length, 1, '$in matched the one existing task');
});

test('sort, select, skip and limit work and combine', async () => {
    for (const n of ['s1', 's2', 's3', 's4', 's5']) await mkTask({ name: n });

    const asc = await GET('/tasks?sort={"name":1}&where={"name":{"$regex":"^s"}}');
    status(asc, 200, 'GET /tasks?sort ascending');
    eqSet(asc.data.map((t) => t.name), ['s1', 's2', 's3', 's4', 's5'], 'all five tasks returned');
    check(JSON.stringify(asc.data.map((t) => t.name)) === JSON.stringify(['s1', 's2', 's3', 's4', 's5']), 'sorted ascending by name');

    const desc = await GET('/tasks?sort={"name":-1}&where={"name":{"$regex":"^s"}}');
    check(JSON.stringify(desc.data.map((t) => t.name)) === JSON.stringify(['s5', 's4', 's3', 's2', 's1']), 'sorted descending by name');

    const page = await GET('/tasks?sort={"name":1}&where={"name":{"$regex":"^s"}}&skip=2&limit=2');
    status(page, 200, 'GET /tasks with sort+skip+limit');
    check(JSON.stringify(page.data.map((t) => t.name)) === JSON.stringify(['s3', 's4']), 'skip=2&limit=2 returns the third and fourth');

    const sel = await GET('/tasks?select={"name":1,"_id":0}&where={"name":"s1"}&limit=1');
    status(sel, 200, 'GET /tasks?select include');
    eqSet(Object.keys(sel.data[0] || {}), ['name'], 'only the selected field is returned');

    const excl = await GET('/users?select={"_id":0}&limit=1');
    status(excl, 200, 'GET /users?select exclude _id');
    check(!('_id' in (excl.data[0] || {})), '_id excluded');
});

test('count returns a number instead of the documents', async () => {
    await mkTask({ name: 'c1', completed: true });
    await mkTask({ name: 'c2', completed: true });
    const r = await GET('/tasks?where={"completed":true}&count=true');
    status(r, 200, 'GET /tasks?count=true');
    check(typeof r.data === 'number', 'data is a number', JSON.stringify(r.data));
    check(r.data >= 2, 'the count includes both completed tasks', String(r.data));

    const zero = await GET('/tasks?where={"name":"definitely-no-such-task-name"}&count=true');
    status(zero, 200, 'GET /tasks?count with no matches');
    eq(zero.data, 0, 'count is 0');

    const users = await GET('/users?count=true');
    status(users, 200, 'GET /users?count=true');
    check(typeof users.data === 'number', 'users count is a number');
});

test('select works on a single user and a single task', async () => {
    const u = await mkUser({ name: 'Selected' });
    const r = await GET(`/users/${u._id}?select={"name":1}`);
    status(r, 200, 'GET /users/:id?select');
    eq(r.data.name, 'Selected', 'the selected field is present');
    check(!('email' in r.data), 'the unselected field is absent');

    const r2 = await GET(`/users/${u._id}?select={"email":0}`);
    status(r2, 200, 'GET /users/:id?select excluding');
    check(!('email' in r2.data), 'the excluded field is absent');
    check('name' in r2.data, 'other fields are present');

    const t = await mkTask({ name: 'Selected task' });
    const r3 = await GET(`/tasks/${t._id}?select={"name":1,"_id":0}`);
    status(r3, 200, 'GET /tasks/:id?select');
    eqSet(Object.keys(r3.data || {}), ['name'], 'only the selected field on a task');

    // Other query parameters are ignored on /:id, they must not turn it into a list
    const r4 = await GET(`/tasks/${t._id}?where={"completed":true}&limit=0&count=true`);
    status(r4, 200, 'GET /tasks/:id ignores the list parameters');
    eq(r4.data._id, t._id, 'still the single task');
});

test('invalid JSON in a query parameter is a 400', async () => {
    for (const q of ['where={bad', 'sort={bad', 'select={bad', 'where=[1,2', 'limit=abc', 'skip=abc', 'count=abc']) {
        status(await GET(`/tasks?${q}`), 400, `GET /tasks?${q}`);
    }
    status(await GET('/users?where={bad'), 400, 'GET /users?where={bad');
    // Check order: the URL id first, so a missing resource stays a 404
    status(await GET(`/users/${MISSING_ID}?select={bad`), 404, 'GET /users/:id with a bad select on a missing user is still 404');
    const u = await mkUser();
    status(await GET(`/users/${u._id}?select={bad`), 400, 'GET /users/:id with a bad select on an existing user is 400');
    status(await GET(`/users/${u._id}?select=5`), 400, 'GET /users/:id with a non-object select is 400');
});

test('duplicate ids in pendingTasks are collapsed', async () => {
    const t = await mkTask();
    const r = await req('POST', '/users', { name: 'Dup', email: email(), pendingTasks: [t._id, t._id] });
    status(r, 201, 'POST /users with a repeated task id');
    eqSet(r.data.pendingTasks, [t._id], 'the id appears once');
    eq((await getUser(r.data._id)).pendingTasks.length, 1, 'stored once in the database');
});

test('a form-encoded body is accepted', async () => {
    const t = await mkTask();
    const body = new URLSearchParams({ name: 'Form User', email: email(), pendingTasks: t._id }).toString();
    const r = await req('POST', '/users', body, { rawBody: true, contentType: 'application/x-www-form-urlencoded' });
    status(r, 201, 'POST /users form-encoded');
    eqSet(r.data.pendingTasks, [t._id], 'the single pendingTasks value became a list');
    eq((await getTask(t._id)).assignedUser, r.data._id, 'the task was assigned');
});

test('where, sort and select must be JSON objects, and skip/limit numbers', async () => {
    status(await GET('/tasks?where=5'), 400, 'GET /tasks?where=5');
    status(await GET('/tasks?sort=5'), 400, 'GET /tasks?sort=5');
    status(await GET('/tasks?select="name"'), 400, 'GET /tasks?select="name"');
    status(await GET('/tasks?limit=-1'), 400, 'GET /tasks?limit=-1');
    status(await GET('/tasks?skip=-1'), 400, 'GET /tasks?skip=-1');
    status(await GET('/tasks?limit=1.5'), 400, 'GET /tasks?limit=1.5');
});

test('GET /tasks defaults to 100 results, GET /users is unlimited', async () => {
    const docs = [];
    for (let i = 0; i < 105; i++) docs.push({ name: `bulk${String(i).padStart(3, '0')}`, deadline: new Date(FUTURE) });
    await Task.insertMany(docs);
    await User.insertMany(docs.map((d, i) => ({ name: d.name, email: `bulk_${stamp}_${i}@illinois.edu` })));

    const tasks = await GET('/tasks');
    status(tasks, 200, 'GET /tasks');
    eq(tasks.data.length, 100, 'tasks default to 100 results');

    const more = await GET('/tasks?limit=105');
    eq(more.data.length, 105, 'an explicit limit overrides the default');

    const users = await GET('/users');
    status(users, 200, 'GET /users');
    eq(users.data.length, 105, 'users are unlimited by default');

    const skipped = await GET('/tasks?sort={"name":1}&skip=100');
    eq(skipped.data.length, 5, 'skip past the first 100 returns the remaining 5');
}, { cleanDb: true });

// ---------------------------------------------------------------- runner

(async () => {
    console.log(`\nMP3 API test suite  (mode: ${MODE})\n`);
    await boot();

    for (const t of tests) {
        currentTest = t.name;
        if (t.cleanDb && !OWNS_DB) {
            console.log(`SKIP  ${t.name}  (needs an empty database)`);
            continue;
        }
        const before = failures.length;
        await reset();
        try {
            await t.fn();
        } catch (e) {
            failures.push({ test: t.name, label: 'threw an exception', detail: e.stack || String(e) });
        }
        const bad = failures.length - before;
        console.log(`${bad ? 'FAIL' : 'ok  '}  ${t.name}${bad ? `  (${bad} failed)` : ''}`);
    }

    if (failures.length) {
        console.log(`\n${'-'.repeat(70)}\nFailures:\n`);
        let last = null;
        for (const f of failures) {
            if (f.test !== last) { console.log(`\n  ${f.test}`); last = f.test; }
            console.log(`    - ${f.label}${f.detail ? `\n        ${f.detail}` : ''}`);
        }
    }

    console.log(`\n${'-'.repeat(70)}`);
    console.log(`${checks - failures.length}/${checks} checks passed in ${tests.length} tests`);
    await shutdown();
    process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
    console.error('\nTest harness error:', e.stack || e);
    try { await shutdown(); } catch { /* ignore */ }
    process.exit(1);
});
