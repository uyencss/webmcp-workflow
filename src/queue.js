class DispatcherQueue {
  constructor() {
    this.runningLocks = new Set();
    this.items = [];
  }

  async run(item, handler) {
    const lockKey = item.allowOverlap ? null : (item.lockKey || 'default');
    if (lockKey && this.runningLocks.has(lockKey)) {
      item.status = 'pending';
      this.items.push(item);
      return { queued: true, item };
    }

    if (lockKey) this.runningLocks.add(lockKey);
    item.status = 'running';
    try {
      const result = await handler(item);
      item.status = result?.exitCode === 0 ? 'completed' : 'failed';
      return { queued: false, item, result };
    } catch (error) {
      item.status = 'failed';
      item.error = { message: error.message, code: error.code };
      throw error;
    } finally {
      if (lockKey) this.runningLocks.delete(lockKey);
    }
  }
}

module.exports = {
  DispatcherQueue,
};
