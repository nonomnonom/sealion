export class SandboxClock {
  realStartTime: Date;
  k: number;
  timeStep: number;

  constructor(k: number = 1) {
    this.realStartTime = new Date();
    this.k = k;
    this.timeStep = 0;
  }

  timeTransfer(now: Date, simStart: Date): Date {
    const diffMs = now.getTime() - this.realStartTime.getTime();
    const adjusted = diffMs * this.k;
    return new Date(simStart.getTime() + adjusted);
  }

  getTimeStep(): string {
    return String(this.timeStep);
  }

  advance(): number {
    this.timeStep += 1;
    return this.timeStep;
  }
}
