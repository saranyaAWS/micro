const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3004;
// How long an agent has to acknowledge before the order is escalated to the next agent
const ESCALATION_TIMEOUT_MS = parseInt(process.env.ESCALATION_TIMEOUT_MS || '120000', 10); // 2 minutes

// ---- In-memory data (swap for Redis/DB in production for multi-instance safety) ----
let agents = [
  { id: 'agent-1', name: 'Agent A', status: 'available' },
  { id: 'agent-2', name: 'Agent B', status: 'available' },
  { id: 'agent-3', name: 'Agent C', status: 'available' }
];

// assignments: orderId -> { agentId, assignedAt, status, escalationCount, timer, triedAgents: [] }
const assignments = {};

function broadcast(event, payload) {
  io.emit(event, payload);
  console.log(`[event] ${event}`, payload);
}

function getNextAvailableAgent(excludeIds = []) {
  return agents.find(a => a.status === 'available' && !excludeIds.includes(a.id));
}

function assignOrderToAgent(orderId, agent, meta = {}) {
  agent.status = 'busy';
  const record = assignments[orderId] || { triedAgents: [], escalationCount: 0 };
  record.agentId = agent.id;
  record.assignedAt = Date.now();
  record.status = 'pending';
  record.triedAgents.push(agent.id);
  record.meta = { ...record.meta, ...meta };

  // Clear any prior timer, then start a fresh one
  if (record.timer) clearTimeout(record.timer);
  record.timer = setTimeout(() => escalateOrder(orderId), ESCALATION_TIMEOUT_MS);

  assignments[orderId] = record;

  broadcast('order:assigned', {
    orderId,
    agentId: agent.id,
    agentName: agent.name,
    escalationCount: record.escalationCount,
    timeoutMs: ESCALATION_TIMEOUT_MS
  });

  return record;
}

function escalateOrder(orderId) {
  const record = assignments[orderId];
  if (!record || record.status !== 'pending') return; // already acknowledged/completed

  // Free up the agent who missed it (mark available again, e.g. after a short cooldown)
  const missedAgent = agents.find(a => a.id === record.agentId);
  if (missedAgent) missedAgent.status = 'available';

  record.escalationCount += 1;

  const nextAgent = getNextAvailableAgent(record.triedAgents);
  if (!nextAgent) {
    broadcast('order:no_agents_available', { orderId, escalationCount: record.escalationCount });
    // retry check shortly instead of dropping the order
    record.timer = setTimeout(() => escalateOrder(orderId), 15000);
    return;
  }

  broadcast('order:escalated', {
    orderId,
    fromAgentId: missedAgent ? missedAgent.id : record.agentId,
    toAgentId: nextAgent.id,
    escalationCount: record.escalationCount
  });

  assignOrderToAgent(orderId, nextAgent, record.meta);
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'escalation-service' }));

app.get('/agents', (req, res) => res.json(agents));

// Manually set an agent's availability (available | busy | offline)
app.post('/agents/:id/status', (req, res) => {
  const { status } = req.body;
  const agent = agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  agent.status = status;
  broadcast('agent:status', { agentId: agent.id, status });
  res.json(agent);
});

// Assign a new order for fulfillment/allocation
app.post('/assign', (req, res) => {
  const { orderId, ...meta } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });

  const agent = getNextAvailableAgent();
  if (!agent) {
    assignments[orderId] = { triedAgents: [], escalationCount: 0, status: 'pending', meta };
    broadcast('order:no_agents_available', { orderId, escalationCount: 0 });
    assignments[orderId].timer = setTimeout(() => escalateOrder(orderId), 15000);
    return res.status(202).json({ orderId, status: 'queued', message: 'no agents available, will retry' });
  }

  const record = assignOrderToAgent(orderId, agent, meta);
  res.status(201).json({ orderId, agentId: agent.id, status: record.status });
});

// Agent acknowledges / picks up the order within the timeout window
app.post('/acknowledge', (req, res) => {
  const { orderId, agentId } = req.body;
  const record = assignments[orderId];
  if (!record) return res.status(404).json({ error: 'no assignment found for this order' });
  if (record.agentId !== agentId) {
    return res.status(409).json({ error: `order is currently assigned to ${record.agentId}, not ${agentId}` });
  }
  if (record.timer) clearTimeout(record.timer);
  record.status = 'acknowledged';
  broadcast('order:acknowledged', { orderId, agentId, escalationCount: record.escalationCount });
  res.json({ orderId, status: 'acknowledged' });
});

// Mark order fully completed (frees the agent)
app.post('/complete', (req, res) => {
  const { orderId } = req.body;
  const record = assignments[orderId];
  if (!record) return res.status(404).json({ error: 'no assignment found for this order' });
  if (record.timer) clearTimeout(record.timer);
  record.status = 'completed';
  const agent = agents.find(a => a.id === record.agentId);
  if (agent) agent.status = 'available';
  broadcast('order:completed', { orderId, agentId: record.agentId });
  res.json({ orderId, status: 'completed' });
});

app.get('/status/:orderId', (req, res) => {
  const record = assignments[req.params.orderId];
  if (!record) return res.status(404).json({ error: 'not found' });
  res.json({ orderId: req.params.orderId, ...record, timer: undefined });
});

io.on('connection', (socket) => {
  console.log('dashboard connected:', socket.id);
  socket.emit('agents:snapshot', agents);
});

server.listen(PORT, () => console.log(`Escalation service running on port ${PORT}`));
