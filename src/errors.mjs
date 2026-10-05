export class ScombError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
