/**
 * rosbus.js — WebROS message bus
 * Drop-in replacement for ROS2 DDS middleware
 * Uses BroadcastChannel for cross-worker pub/sub
 */

class ROSBus {
  constructor() {
    this.channel = new BroadcastChannel('rosbus');
    this.subscriptions = new Map(); // topic → [{msgType, callback}]
    this.services = new Map();      // service_name → handler
    this.nodes = new Map();         // node_name → {topics, services}
    this.topicRegistry = new Map(); // topic → {msgType, count}
    this.topicPublishers = new Map(); // topic → Set<nodeName>
    this.topicSubscribers = new Map(); // topic → Set<nodeName>
    this._pendingServices = new Map(); // call_id → {resolve, reject}

    this.channel.onmessage = (e) => this._dispatch(e.data);
    this._callIdCounter = 0;
    this._publishHooks = []; // same-window publish listeners (BroadcastChannel doesn't echo to sender)
  }

  // Register a callback fired on every publish in this window (topics.js uses this)
  onPublish(fn) {
    this._publishHooks.push(fn);
  }

  // ── Publisher ──────────────────────────────────────────────────────────────
  publish(topic, msgType, data) {
    const envelope = {
      _type: 'topic',
      topic,
      msgType,
      data,
      stamp: performance.now()
    };
    // Local dispatch (same window)
    this._dispatch(envelope);
    // Cross-worker dispatch
    this.channel.postMessage(envelope);

    // Register topic
    if (!this.topicRegistry.has(topic)) {
      this.topicRegistry.set(topic, { msgType, count: 0 });
    }
    this.topicRegistry.get(topic).count++;

    // Notify same-window listeners (BroadcastChannel doesn't echo back to sender)
    this._publishHooks.forEach(fn => { try { fn(topic, msgType, performance.now()); } catch(e) {} });
  }

  // ── Subscriber ─────────────────────────────────────────────────────────────
  subscribe(topic, msgType, callback) {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, []);
    }
    const sub = { msgType, callback, id: Math.random() };
    this.subscriptions.get(topic).push(sub);
    return sub.id;
  }

  unsubscribe(topic, subId) {
    if (!this.subscriptions.has(topic)) return;
    const subs = this.subscriptions.get(topic).filter(s => s.id !== subId);
    this.subscriptions.set(topic, subs);
  }

  // ── Services ───────────────────────────────────────────────────────────────
  advertiseService(name, handler) {
    this.services.set(name, handler);
  }

  async callService(name, request) {
    const callId = ++this._callIdCounter;
    return new Promise((resolve, reject) => {
      this._pendingServices.set(callId, { resolve, reject });
      setTimeout(() => {
        if (this._pendingServices.has(callId)) {
          this._pendingServices.delete(callId);
          reject(new Error(`Service ${name} timed out`));
        }
      }, 5000);
      this.channel.postMessage({
        _type: 'service_call',
        name, request, callId
      });
    });
  }

  // ── Node registration ──────────────────────────────────────────────────────
  registerNode(name) {
    this.nodes.set(name, { topics: [], services: [], stamp: Date.now() });
    this.channel.postMessage({ _type: 'node_register', name });
  }

  unregisterNode(name) {
    this.nodes.delete(name);
    this.channel.postMessage({ _type: 'node_unregister', name });
  }

  // ── Graph tracking ─────────────────────────────────────────────────────────
  trackPublisher(topic, nodeName, msgType) {
    if (!this.topicPublishers.has(topic)) this.topicPublishers.set(topic, new Set());
    this.topicPublishers.get(topic).add(nodeName);
  }

  trackSubscriber(topic, nodeName) {
    if (!this.topicSubscribers.has(topic)) this.topicSubscribers.set(topic, new Set());
    this.topicSubscribers.get(topic).add(nodeName);
  }

  // Clear all runtime tracking — call on Stop to return to clean state
  resetTracking() {
    this.nodes.clear();
    this.topicRegistry.clear();
    this.topicPublishers.clear();
    this.topicSubscribers.clear();
  }

  subscribeAs(topic, msgType, callback, nodeName) {
    const id = this.subscribe(topic, msgType, callback);
    this.trackSubscriber(topic, nodeName);
    return id;
  }

  getGraph() {
    const activeNodes = new Set(this.nodes.keys());
    const nodes = [...activeNodes].map(n => ({ id: 'node:' + n, name: n, kind: 'node' }));
    const topics = [...this.topicRegistry.keys()].map(t => ({
      id: 'topic:' + t, name: t, kind: 'topic',
      msgType: this.topicRegistry.get(t)?.msgType
    }));
    const edges = [];
    this.topicPublishers.forEach((publishers, topic) => {
      publishers.forEach(node => {
        if (activeNodes.has(node))
          edges.push({ from: 'node:' + node, to: 'topic:' + topic, type: 'pub' });
      });
    });
    this.topicSubscribers.forEach((subscribers, topic) => {
      subscribers.forEach(node => {
        if (activeNodes.has(node))
          edges.push({ from: 'topic:' + topic, to: 'node:' + node, type: 'sub' });
      });
    });
    return { nodes, topics, edges };
  }

  // ── Introspection (ros2 topic list, ros2 node list) ─────────────────────────
  getTopics() {
    return Array.from(this.topicRegistry.entries()).map(([topic, info]) => ({
      topic, ...info
    }));
  }

  getNodes() {
    return Array.from(this.nodes.keys());
  }

  // ── Internal dispatch ──────────────────────────────────────────────────────
  _dispatch(envelope) {
    if (!envelope || !envelope._type) return;

    if (envelope._type === 'topic') {
      const subs = this.subscriptions.get(envelope.topic) || [];
      subs.forEach(sub => {
        try { sub.callback(envelope.data, envelope); }
        catch (_) {}
      });
    }

    if (envelope._type === 'service_call') {
      const handler = this.services.get(envelope.name);
      if (handler) {
        Promise.resolve(handler(envelope.request)).then(response => {
          this.channel.postMessage({
            _type: 'service_response',
            callId: envelope.callId,
            response
          });
        });
      }
    }

    if (envelope._type === 'service_response') {
      const pending = this._pendingServices.get(envelope.callId);
      if (pending) {
        this._pendingServices.delete(envelope.callId);
        pending.resolve(envelope.response);
      }
    }

    if (envelope._type === 'node_register') {
      if (!this.nodes.has(envelope.name)) {
        this.nodes.set(envelope.name, { stamp: Date.now() });
      }
    }
    if (envelope._type === 'node_unregister') {
      this.nodes.delete(envelope.name);
    }
  }
}

// Singleton
const rosBus = new ROSBus();
window.rosBus = rosBus;
