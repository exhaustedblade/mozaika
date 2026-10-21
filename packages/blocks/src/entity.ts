/**
 * Something that moves through the blocks of a model: a customer, a part, a
 * request. The blocks read only `id` and `createdAt`, so any object with these
 * two fields can travel through them, an agent for example; keep the class
 * without private fields, or TypeScript would stop accepting such objects.
 */
export class Entity {
  /**
   * Arrivals at the sources of a simulation are numbered 1, 2, 3… in order;
   * an entity made by a source's factory may carry its own id (an agent: its
   * number in its population).
   */
  readonly id: number;
  /** Model time at which the entity was created (its arrival at the source). */
  readonly createdAt: number;

  constructor(id: number, createdAt: number) {
    this.id = id;
    this.createdAt = createdAt;
  }
}
