const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError, isObjectId, send, handleError, listHandler, getOneHandler } = require('./helpers');

const router = express.Router();

// Check field formats (all 400 errors) and fill in defaults
function validateTaskBody(body) {
  const { name, deadline } = body;
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'Task name is required');

  if (deadline === undefined || deadline === null || deadline === '') {
    throw new ApiError(400, 'Task deadline is required');
  }
  let d;
  if (typeof deadline === 'number') d = new Date(deadline);
  else if (typeof deadline === 'string') d = /^-?\d+$/.test(deadline) ? new Date(Number(deadline)) : new Date(deadline);
  else throw new ApiError(400, 'Task deadline must be a valid date');
  if (isNaN(d.getTime())) throw new ApiError(400, 'Task deadline must be a valid date');

  let description = body.description;
  if (description === undefined || description === null) description = '';
  if (typeof description !== 'string') throw new ApiError(400, 'Task description must be a string');

  let completed = body.completed;
  if (completed === undefined || completed === null || completed === '') completed = false;
  else if (completed === 'true') completed = true;
  else if (completed === 'false') completed = false;
  if (typeof completed !== 'boolean') throw new ApiError(400, 'completed must be true or false');

  let assignedUser = body.assignedUser;
  if (assignedUser === undefined || assignedUser === null) assignedUser = '';
  if (typeof assignedUser !== 'string') throw new ApiError(400, 'assignedUser must be a user id');
  if (assignedUser !== '' && !isObjectId(assignedUser)) throw new ApiError(400, 'assignedUser is not a valid user id');

  let assignedUserName = body.assignedUserName;
  if (assignedUserName === null || assignedUserName === '') assignedUserName = undefined;
  if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
    throw new ApiError(400, 'assignedUserName must be a string');
  }
  if (assignedUser === '' && assignedUserName !== undefined && assignedUserName !== 'unassigned') {
    throw new ApiError(400, 'assignedUserName is set but assignedUser is empty');
  }

  return { name, description, deadline: d, completed, assignedUser, assignedUserName };
}

// Shared by POST (existing = null) and PUT (existing = current task doc)
async function writeTask(body, existing) {
  const data = validateTaskBody(body);

  // Referenced user must exist (404), and the name must match (400)
  let userName = 'unassigned';
  if (data.assignedUser) {
    const u = await User.findById(data.assignedUser);
    if (!u) throw new ApiError(404, 'Assigned user does not exist');
    if (data.assignedUserName !== undefined && data.assignedUserName !== u.name) {
      throw new ApiError(400, 'assignedUserName does not match the assigned user');
    }
    userName = u.name;
  }

  // All checks passed, now write
  const task = existing || new Task();
  task.name = data.name;
  task.description = data.description;
  task.deadline = data.deadline;
  task.completed = data.completed;
  task.assignedUser = data.assignedUser;
  task.assignedUserName = userName;
  await task.save();
  const tid = task._id.toString();

  // Only the assigned user keeps it in pendingTasks, and only if it is not completed
  const keepPending = data.assignedUser && !data.completed;
  const pullFilter = { pendingTasks: tid };
  if (keepPending) pullFilter._id = { $ne: data.assignedUser };
  await User.updateMany(pullFilter, { $pull: { pendingTasks: tid } });
  if (keepPending) {
    await User.updateOne({ _id: data.assignedUser }, { $addToSet: { pendingTasks: tid } });
  }

  return task;
}

router.get('/', (req, res) => listHandler(Task, 100, req, res));

router.post('/', async (req, res) => {
  try {
    const task = await writeTask(req.body || {}, null);
    return send(res, 201, 'Task created', task);
  } catch (err) {
    return handleError(res, err);
  }
});

router.get('/:id', (req, res) => getOneHandler(Task, 'Task', req, res));

router.put('/:id', async (req, res) => {
  try {
    const existing = isObjectId(req.params.id) ? await Task.findById(req.params.id) : null;
    if (!existing) throw new ApiError(404, 'Task not found');
    const task = await writeTask(req.body || {}, existing);
    return send(res, 200, 'Task updated', task);
  } catch (err) {
    return handleError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const task = isObjectId(req.params.id) ? await Task.findById(req.params.id) : null;
    if (!task) throw new ApiError(404, 'Task not found');
    const tid = task._id.toString();
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
    await Task.deleteOne({ _id: task._id });
    return send(res, 200, 'Task deleted', task);
  } catch (err) {
    return handleError(res, err);
  }
});

module.exports = router;
