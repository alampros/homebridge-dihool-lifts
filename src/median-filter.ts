/**
 * Small rolling median filter for suppressing short-lived ToF jitter.
 * Returns undefined until enough samples have been collected.
 */
export class MedianFilter {
  private readonly samples: number[] = [];

  constructor(
    private readonly windowSize = 5,
    private readonly minimumSamples = 3,
  ) {
    if (windowSize < 1 || minimumSamples < 1 || minimumSamples > windowSize) {
      throw new Error('Invalid median filter sample sizes');
    }
  }

  add(sample: number): number | undefined {
    if (!Number.isFinite(sample)) {
      return undefined;
    }

    this.samples.push(sample);
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
    if (this.samples.length < this.minimumSamples) {
      return undefined;
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  reset(): void {
    this.samples.length = 0;
  }
}
