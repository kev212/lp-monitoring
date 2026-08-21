let generation = 0
let running = false

export function isBotRunning(): boolean {
  return running
}

export function setBotRunning(value: boolean): void {
  running = value
}

export function getLifecycleGeneration(): number {
  return generation
}

export function bumpLifecycleGeneration(): number {
  generation += 1
  return generation
}
