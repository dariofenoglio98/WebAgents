/**
 * One operation at a time (T16 review 1, findings 2 and 5): a promise chain that runs each piece
 * of work after the previous one settled, whether it resolved or rejected. A store whose
 * operations read, decide and write in separate steps needs its operations serialized, or a
 * read that began before a lock, a wipe or a re-key writes the old state back after it.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
