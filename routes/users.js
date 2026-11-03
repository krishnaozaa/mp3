const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError, isObjectId, send, handleError, listHandler, getOneHandler } = require('./helpers');

const router = express.Router();

// Check name/email/pendingTasks format (all 400 errors)
function validateUserBody(body) {
  const { name, email } = body;
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'User name is required');
  if (typeof email !== 'string' || !email.trim()) throw new ApiError(400, 'User email is required');

  let pending = body.pendingTasks;
  if (pending === undefined || pending === null || pending === '') pending = [];
  if (typeof pending === 'string') pending = [pending]; // single value from form-encoded body
  if (!Array.isArray(pending)) throw new ApiError(400, 'pendingTasks must be a list of task ids');
  for (const t of pending) {
    if (!isObjectId(t)) throw new ApiError(400, 'pendingTasks contains an invalid task id');
  }
  return { name, email, pendingTasks: [...new Set(pending)] };
}

// Shared by POST (existing = null) and PUT (existing = current user doc)
async function writeUser(body, existing) {
  const data = validateUserBody(body);

  // Unique email
  const dupFilter = { email: data.email };
  if (existing) dupFilter._id = { $ne: existing._id };
  if (await User.exists(dupFilter)) throw new ApiError(400, 'A user with this email already exists');

  // Referenced tasks: completed -> 400, missing -> 404
  const tasks = await Task.find({ _id: { $in: data.pendingTasks } });
  if (tasks.some((t) => t.completed)) throw new ApiError(400, 'Completed tasks cannot be in pendingTasks');
  if (tasks.length !== data.pendingTasks.length) throw new ApiError(404, 'One or more tasks in pendingTasks do not exist');

  // All checks passed, now write
  const oldPending = existing ? existing.pendingTasks.slice() : [];
  const user = existing || new User();
  user.name = data.name;
  user.email = data.email;
  user.pendingTasks = data.pendingTasks;
  await user.save();
  const uid = user._id.toString();

  // Tasks dropped from the list get unassigned
  const removed = oldPending.filter((t) => !data.pendingTasks.includes(t));
  if (removed.length) {
    await Task.updateMany(
      { _id: { $in: removed.filter(isObjectId) }, assignedUser: uid },
      { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );
  }

  if (data.pendingTasks.length) {
    // Tasks moving from another user: remove them from that user's list
    await User.updateMany(
      { _id: { $ne: user._id }, pendingTasks: { $in: data.pendingTasks } },
      { $pull: { pendingTasks: { $in: data.pendingTasks } } }
    );
    await Task.updateMany(
      { _id: { $in: data.pendingTasks } },
      { $set: { assignedUser: uid, assignedUserName: user.name } }
    );
  }

  // Keep assignedUserName in sync if the name changed (completed tasks too)
  await Task.updateMany({ assignedUser: uid }, { $set: { assignedUserName: user.name } });

  return user;
}

router.get('/', (req, res) => listHandler(User, 0, req, res)); // 0 = no limit

router.post('/', async (req, res) => {
  try {
    const user = await writeUser(req.body || {}, null);
    return send(res, 201, 'User created', user);
  } catch (err) {
    return handleError(res, err);
  }
});

router.get('/:id', (req, res) => getOneHandler(User, 'User', req, res));

router.put('/:id', async (req, res) => {
  try {
    const existing = isObjectId(req.params.id) ? await User.findById(req.params.id) : null;
    if (!existing) throw new ApiError(404, 'User not found');
    const user = await writeUser(req.body || {}, existing);
    return send(res, 200, 'User updated', user);
  } catch (err) {
    return handleError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const user = isObjectId(req.params.id) ? await User.findById(req.params.id) : null;
    if (!user) throw new ApiError(404, 'User not found');
    const uid = user._id.toString();
    // Unassign all of this user's tasks, including completed ones
    await Task.updateMany({ assignedUser: uid }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } });
    await User.deleteOne({ _id: user._id });
    return res.status(204).end(); // 204 No Content: nothing left to describe
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
