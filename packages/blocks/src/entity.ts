/** Something that moves through the blocks of a model: a customer, a part, a request. */
export class Entity {
  /** Unique within a simulation: 1, 2, 3… in the order of creation. */
  readonly id: number;
  /** Model time at which the entity was created (its arrival at the source). */
  readonly createdAt: number;

  constructor(id: number, createdAt: number) {
    this.id = id;
    this.createdAt = createdAt;
  }
}
