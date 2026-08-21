/**
 * ============================================================================
 * RESIDENTIAL PROXY MANAGER - Production Grade
 * ============================================================================
 *
 * Multi-provider proxy rotation with circuit breaker, health checks,
 * and automatic failover for mass scraping operations.
 *
 * Supported Providers:
 * - DataImpulse ($1/GB) - Best value, recommended for mass scraping
 * - Smartproxy ($1.5/GB) - Reliable residential IPs
 * - Webshare ($1.45/GB) - Good balance of price/quality
 * - SOAX ($2.5/GB) - Large IP pool, good rotation
 * - Bright Data ($5.04/GB) - Premium quality
 * - Oxylabs ($3/GB) - Enterprise grade
 *
 * Environment Variables:
 *   Generic configuration:
 *     PROXY_PROVIDER=dataimpulse|smartproxy|webshare|soax|brightdata|oxylabs
 *     PROXY_USERNAME=your_username
 *     PROXY_PASSWORD=your_password
 *
 *   Provider-specific (takes precedence):
 *     DATAIMPULSE_USERNAME=your_username
 *     DATAIMPULSE_PASSWORD=your_password
 *     SMARTPROXY_USERNAME=your_username
 *     SMARTPROXY_PASSWORD=your_password
 *     ... (similar for other providers)
 *
 * Usage:
 *   // Auto-configure from environment variables:
 *   const proxyManager = createProxyManager({ targetCountry: 'in' });
 *
 *   // Manual configuration:
 *   const proxyManager = new ProxyManager();
 *   proxyManager.addProvider('dataimpulse', username, password);
 *
 *   // Get proxy agent for fetch:
 *   const agent = proxyManager.getProxyAgent();
 *   fetch(url, { agent });
 *
 *   // Record success/failure for statistics:
 *   proxyManager.recordSuccess(latencyMs, responseSize);
 *   proxyManager.recordFailure('rate_limited');
 *
 *   // Rotate session (new IP):
 *   proxyManager.rotateSession();
 */

import { execFileSync } from 'child_process';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ============================================================================
// TYPES
// ============================================================================

export type ProxyProvider =
  | 'dataimpulse'
  | 'smartproxy'
  | 'webshare'
  | 'soax'
  | 'brightdata'
  | 'oxylabs'
  | 'custom';

export interface ProxyConfig {
  provider: ProxyProvider;
  username: string;
  password: string;
  endpoint?: string; // Custom endpoint override
  country?: string; // Target country (default: 'in' for India)
}

export interface ProviderStats {
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  totalLatency: number;
  bytesTransferred: number;
  lastUsed: number;
  circuitBreakerUntil: number;
  isHealthy: boolean;
}

export interface ProxyManagerConfig {
  sessionRotationRequests: number; // Rotate session every N requests
  circuitBreakerThreshold: number; // Open circuit after N consecutive failures
  circuitBreakerResetMs: number; // Reset circuit after N ms
  healthCheckIntervalMs: number; // Health check interval
  targetCountry: string; // Target country for geo-targeting
  enableLogging: boolean; // Enable detailed logging
  roundRobinProviders: boolean; // Rotate providers on each request for ASN diversity
}

// ============================================================================
// PROVIDER CONFIGURATIONS
// ============================================================================

interface ProviderDefinition {
  name: string;
  endpoint: string;
  formatUrl: (username: string, password: string, sessionId: string, country: string) => string;
  pricePerGB: number;
  healthCheckUrl: string;
  maxSessionMinutes: number;
}

const PROVIDER_DEFINITIONS: Record<ProxyProvider, ProviderDefinition> = {
  dataimpulse: {
    name: 'DataImpulse',
    endpoint: 'gw.dataimpulse.com:823',
    // ROTATING IP + ASN DIVERSITY: Use random session ID per request
    // DataImpulse parameters: __cr (country), __sid (session), __asn (ASN filter)
    // To maximize ASN diversity for avoiding rate limits:
    // - Use global pool (no __cr) OR just country with unique sessions
    // - Each unique __sid = new IP from different ASN when possible
    formatUrl: (user, pass, _session, country) => {
      // Generate random session ID for each call to get new IP
      const randomSession = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
      // Multi-country pool for maximum ASN diversity
      // Set DATAIMPULSE_COUNTRY to comma-separated list: "al,ar,in,id,iq,il,gb,us"
      // More countries = more ISPs = more ASNs = better rate limit avoidance
      // Leave empty/unset for global pool (all countries)
      const useCountry = process.env.DATAIMPULSE_COUNTRY || country || '';
      if (useCountry && useCountry !== 'global') {
        // Supports single country (in) or multi-country (al,ar,in,id,iq,il,gb,us)
        return `http://${user}__cr.${useCountry}__sid.${randomSession}:${pass}@gw.dataimpulse.com:823`;
      }
      // Global pool - maximum ASN diversity (all countries)
      return `http://${user}__sid.${randomSession}:${pass}@gw.dataimpulse.com:823`;
    },
    pricePerGB: 1.0,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 120,
  },
  smartproxy: {
    name: 'Smartproxy',
    endpoint: 'gate.smartproxy.com:7000',
    formatUrl: (user, pass, session, country) =>
      `http://${user}-session-${session}-country-${country}:${pass}@gate.smartproxy.com:7000`,
    pricePerGB: 1.5,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 30,
  },
  webshare: {
    name: 'Webshare',
    // Webshare Rotating Residential Proxy
    // Docs: https://proxy2.webshare.io/docs/rotating-residential
    // For rotating proxy, username already includes '-rotate' suffix
    // Format: username-rotate:password@p.webshare.io:80
    // Example: aimuzkqq-rotate:puylkk0mcm15@p.webshare.io:80
    endpoint: 'p.webshare.io:80',
    formatUrl: (user, pass, _session, _country) => {
      // Webshare rotating residential proxies:
      // - Username already contains '-rotate' suffix for auto-rotation
      // - Each request automatically gets a new IP
      // - Country targeting available via dashboard, not URL
      // Simple format: username:password@host:port
      return `http://${user}:${pass}@p.webshare.io:80`;
    },
    pricePerGB: 1.45,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 60, // Webshare sessions can last up to 60 min
  },
  soax: {
    name: 'SOAX',
    endpoint: 'proxy.soax.com:5000',
    formatUrl: (user, pass, session, country) =>
      `http://${user}:${pass}_country-${country}_session-${session}@proxy.soax.com:5000`,
    pricePerGB: 2.5,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 60,
  },
  brightdata: {
    name: 'Bright Data',
    endpoint: 'brd.superproxy.io:22225',
    formatUrl: (user, pass, session, country) =>
      `http://brd-customer-${user}-zone-residential-session-${session}-country-${country}:${pass}@brd.superproxy.io:22225`,
    pricePerGB: 5.04,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 30,
  },
  oxylabs: {
    name: 'Oxylabs',
    endpoint: 'pr.oxylabs.io:7777',
    formatUrl: (user, pass, session, country) =>
      `http://customer-${user}-cc-${country}-sessid-${session}:${pass}@pr.oxylabs.io:7777`,
    pricePerGB: 3.0,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 30,
  },
  custom: {
    name: 'Custom',
    endpoint: '',
    formatUrl: (user, pass, session, country) => `http://${user}:${pass}@custom.proxy:8080`,
    pricePerGB: 0,
    healthCheckUrl: 'https://httpbin.org/ip',
    maxSessionMinutes: 30,
  },
};

// ============================================================================
// PROXY MANAGER CLASS
// ============================================================================

export class ProxyManager {
  private providers: ProxyConfig[] = [];
  private stats: Map<ProxyProvider, ProviderStats> = new Map();
  private currentProviderIndex = 0;
  private currentSessionId: string;
  private requestsInCurrentSession = 0;
  private config: ProxyManagerConfig;
  private isEnabled = false;

  constructor(config: Partial<ProxyManagerConfig> = {}) {
    this.config = {
      sessionRotationRequests: 10, // Rotate IP every 10 requests to avoid rate limits
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60000,
      healthCheckIntervalMs: 300000,
      targetCountry: 'in',
      enableLogging: true,
      roundRobinProviders: true, // Default: rotate between providers for ASN diversity
      ...config,
    };
    this.currentSessionId = this.generateSessionId();
  }

  // ============================================================================
  // PUBLIC METHODS
  // ============================================================================

  /**
   * Add a proxy provider
   */
  addProvider(
    provider: ProxyProvider,
    username: string,
    password: string,
    endpoint?: string,
  ): void {
    this.providers.push({
      provider,
      username,
      password,
      endpoint,
      country: this.config.targetCountry,
    });

    this.stats.set(provider, {
      requests: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      totalLatency: 0,
      bytesTransferred: 0,
      lastUsed: 0,
      circuitBreakerUntil: 0,
      isHealthy: true,
    });

    this.isEnabled = true;
    this.log(`Added provider: ${PROVIDER_DEFINITIONS[provider].name}`);
  }

  /**
   * Configure from environment variables
   */
  configureFromEnv(): void {
    const providerMap: Record<string, ProxyProvider> = {
      DATAIMPULSE: 'dataimpulse',
      SMARTPROXY: 'smartproxy',
      WEBSHARE: 'webshare',
      SOAX: 'soax',
      BRIGHTDATA: 'brightdata',
      OXYLABS: 'oxylabs',
    };

    for (const [envPrefix, provider] of Object.entries(providerMap)) {
      const username = process.env[`${envPrefix}_USERNAME`] || process.env[`PROXY_USERNAME`];
      const password = process.env[`${envPrefix}_PASSWORD`] || process.env[`PROXY_PASSWORD`];
      const endpoint = process.env[`${envPrefix}_ENDPOINT`];

      if (username && password) {
        this.addProvider(provider, username, password, endpoint);
      }
    }

    // Also check for generic PROXY_ environment variables with PROXY_PROVIDER
    const genericProvider = process.env.PROXY_PROVIDER?.toLowerCase() as ProxyProvider | undefined;
    const genericUsername = process.env.PROXY_USERNAME;
    const genericPassword = process.env.PROXY_PASSWORD;

    if (
      genericProvider &&
      genericUsername &&
      genericPassword &&
      !this.providers.find((p) => p.provider === genericProvider)
    ) {
      this.addProvider(genericProvider, genericUsername, genericPassword);
    }

    if (this.providers.length > 0) {
      this.log(`Configured ${this.providers.length} provider(s) from environment`);
    }
  }

  /**
   * Check if proxy is enabled
   */
  isProxyEnabled(): boolean {
    return this.isEnabled && this.providers.length > 0;
  }

  /**
   * Get the current proxy URL
   */
  getProxyUrl(): string | null {
    if (!this.isEnabled || this.providers.length === 0) {
      return null;
    }

    const provider = this.getActiveProvider();
    if (!provider) return null;

    const definition = PROVIDER_DEFINITIONS[provider.provider];
    return definition.formatUrl(
      provider.username,
      provider.password,
      this.currentSessionId,
      provider.country || this.config.targetCountry,
    );
  }

  /**
   * Get an HttpsProxyAgent for use with fetch
   * IMPORTANT: Creates agent with keep-alive DISABLED to force new IP per request
   */
  getProxyAgent(): HttpsProxyAgent<string> | null {
    const proxyUrl = this.getProxyUrl();
    if (!proxyUrl) return null;

    // Disable keep-alive to force DataImpulse to assign new IP per connection
    return new HttpsProxyAgent(proxyUrl, {
      keepAlive: false,
      maxSockets: 1,
      maxFreeSockets: 0,
      timeout: 30000,
    });
  }

  /**
   * Response from curlFetch with status info
   */
  curlFetch(
    url: string,
    options: { timeout?: number; headers?: Record<string, string> } = {},
  ): { body: string; status: number; headers: Record<string, string> } {
    const proxyUrl = this.getProxyUrl();
    if (!proxyUrl) {
      throw new Error('No proxy configured');
    }

    const timeout = options.timeout || 30000;

    // Build curl arguments array for proper escaping
    // Use -o - to output body to stdout and -w for status code at the very end
    const curlArgs: string[] = [
      '-s', // Silent mode
      '-o',
      '-', // Output body to stdout
      '-w',
      '__HTTP_STATUS__%{http_code}', // Write status code at end (no newline prefix)
      '--compressed', // Auto-decompress gzip/deflate responses
      '--proxy',
      proxyUrl,
    ];

    // Add headers with proper escaping
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        curlArgs.push('-H', `${key}: ${value}`);
      }
    }

    curlArgs.push(url);

    try {
      const startTime = Date.now();
      // Use execFileSync for proper argument escaping (avoids shell injection)
      const result = execFileSync('curl', curlArgs, {
        timeout,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      }) as string;

      const latency = Date.now() - startTime;

      // Parse status code from end - it's appended right after the body
      const statusMatch = result.match(/__HTTP_STATUS__(\d+)$/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 200;
      const body = result.replace(/__HTTP_STATUS__\d+$/, '');

      this.recordSuccess(latency, body.length);

      // We don't get response headers with this simpler approach
      return { body, status, headers: {} };
    } catch (error) {
      this.recordFailure(String(error));
      throw error;
    }
  }

  /**
   * Simple curl fetch returning just the body (for backward compatibility)
   */
  curlFetchBody(
    url: string,
    options: { timeout?: number; headers?: Record<string, string> } = {},
  ): string {
    const proxyUrl = this.getProxyUrl();
    if (!proxyUrl) {
      throw new Error('No proxy configured');
    }

    const timeout = options.timeout || 30000;

    // Build curl arguments array for proper escaping
    const curlArgs: string[] = ['-s', '--compressed', '--proxy', proxyUrl];

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        curlArgs.push('-H', `${key}: ${value}`);
      }
    }

    curlArgs.push(url);

    try {
      const startTime = Date.now();
      const result = execFileSync('curl', curlArgs, {
        timeout,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      }) as string;
      const latency = Date.now() - startTime;
      this.recordSuccess(latency, result.length);
      return result;
    } catch (error) {
      this.recordFailure(String(error));
      throw error;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(latencyMs: number, bytesReceived: number = 0): void {
    const provider = this.getCurrentProvider();
    if (!provider) return;

    const stats = this.stats.get(provider.provider);
    if (stats) {
      stats.requests++;
      stats.successes++;
      stats.consecutiveFailures = 0;
      stats.totalLatency += latencyMs;
      stats.bytesTransferred += bytesReceived;
      stats.lastUsed = Date.now();
      stats.isHealthy = true;
    }

    this.requestsInCurrentSession++;
    this.maybeRotateSession();
  }

  /**
   * Record a failed request
   */
  recordFailure(error: string): void {
    const provider = this.getCurrentProvider();
    if (!provider) return;

    const stats = this.stats.get(provider.provider);
    if (stats) {
      stats.requests++;
      stats.failures++;
      stats.consecutiveFailures++;
      stats.lastUsed = Date.now();

      // Circuit breaker
      if (stats.consecutiveFailures >= this.config.circuitBreakerThreshold) {
        stats.circuitBreakerUntil = Date.now() + this.config.circuitBreakerResetMs;
        stats.isHealthy = false;
        this.log(`⚡ Circuit breaker OPEN for ${PROVIDER_DEFINITIONS[provider.provider].name}`);
        this.switchToNextProvider();
      }
    }
  }

  /**
   * Manually rotate to a new session
   * Note: For DataImpulse without __sid, this is a no-op since every request gets new IP
   */
  rotateSession(): void {
    this.currentSessionId = this.generateSessionId();
    this.requestsInCurrentSession = 0;
    // Only log for providers that actually use session IDs (not DataImpulse rotating mode)
    // this.log(`🔄 Rotated to new session: ${this.currentSessionId.substring(0, 8)}...`);
  }

  /**
   * Get current provider stats
   */
  getStats(): Map<ProxyProvider, ProviderStats> {
    return new Map(this.stats);
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    enabled: boolean;
    providersCount: number;
    totalRequests: number;
    totalSuccesses: number;
    totalFailures: number;
    successRate: number;
    avgLatency: number;
    estimatedCostUSD: number;
  } {
    let totalRequests = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    let totalLatency = 0;
    let totalBytes = 0;
    let weightedCost = 0;

    this.stats.forEach((stats, provider) => {
      totalRequests += stats.requests;
      totalSuccesses += stats.successes;
      totalFailures += stats.failures;
      totalLatency += stats.totalLatency;
      totalBytes += stats.bytesTransferred;
      weightedCost +=
        (stats.bytesTransferred / (1024 * 1024 * 1024)) * PROVIDER_DEFINITIONS[provider].pricePerGB;
    });

    return {
      enabled: this.isEnabled,
      providersCount: this.providers.length,
      totalRequests,
      totalSuccesses,
      totalFailures,
      successRate: totalRequests > 0 ? (totalSuccesses / totalRequests) * 100 : 0,
      avgLatency: totalSuccesses > 0 ? totalLatency / totalSuccesses : 0,
      estimatedCostUSD: weightedCost,
    };
  }

  /**
   * Perform health check on all providers
   */
  async healthCheck(): Promise<Map<ProxyProvider, boolean>> {
    const results = new Map<ProxyProvider, boolean>();

    for (const provider of this.providers) {
      const definition = PROVIDER_DEFINITIONS[provider.provider];
      const proxyUrl = definition.formatUrl(
        provider.username,
        provider.password,
        this.generateSessionId(),
        provider.country || this.config.targetCountry,
      );

      try {
        const agent = new HttpsProxyAgent(proxyUrl);
        const response = await fetch(definition.healthCheckUrl, {
          // @ts-expect-error - agent works with fetch in Node 18+
          agent,
          signal: AbortSignal.timeout(10000),
        });

        const healthy = response.ok;
        results.set(provider.provider, healthy);

        const stats = this.stats.get(provider.provider);
        if (stats) {
          stats.isHealthy = healthy;
          if (healthy) {
            stats.circuitBreakerUntil = 0;
          }
        }

        this.log(`Health check ${provider.provider}: ${healthy ? '✅' : '❌'}`);
      } catch (error) {
        results.set(provider.provider, false);
        const stats = this.stats.get(provider.provider);
        if (stats) {
          stats.isHealthy = false;
        }
        this.log(`Health check ${provider.provider}: ❌ ${error}`);
      }
    }

    return results;
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private getCurrentProvider(): ProxyConfig | null {
    if (this.providers.length === 0) return null;
    return this.providers[this.currentProviderIndex];
  }

  private getActiveProvider(): ProxyConfig | null {
    if (this.providers.length === 0) return null;

    // Round-robin mode: rotate between providers on each request for ASN diversity
    if (this.config.roundRobinProviders && this.providers.length > 1) {
      // Try each provider starting from current index
      for (let i = 0; i < this.providers.length; i++) {
        const index = (this.currentProviderIndex + i) % this.providers.length;
        const provider = this.providers[index];
        const stats = this.stats.get(provider.provider);

        if (stats) {
          // Check if circuit breaker has reset
          if (stats.circuitBreakerUntil > 0 && Date.now() > stats.circuitBreakerUntil) {
            stats.circuitBreakerUntil = 0;
            stats.consecutiveFailures = 0;
            stats.isHealthy = true;
            this.log(
              `⚡ Circuit breaker RESET for ${PROVIDER_DEFINITIONS[provider.provider].name}`,
            );
          }

          if (stats.isHealthy) {
            // Found healthy provider, advance index for next call (round-robin)
            this.currentProviderIndex = (index + 1) % this.providers.length;
            return provider;
          }
        }
      }
      // All providers unhealthy, use first anyway but advance index
      this.log(`⚠️ All providers unhealthy, using first provider`);
      this.currentProviderIndex = 1 % this.providers.length;
      return this.providers[0];
    }

    // Non-round-robin: stick with current provider until it fails
    for (let i = 0; i < this.providers.length; i++) {
      const index = (this.currentProviderIndex + i) % this.providers.length;
      const provider = this.providers[index];
      const stats = this.stats.get(provider.provider);

      if (stats) {
        // Check if circuit breaker has reset
        if (stats.circuitBreakerUntil > 0 && Date.now() > stats.circuitBreakerUntil) {
          stats.circuitBreakerUntil = 0;
          stats.consecutiveFailures = 0;
          stats.isHealthy = true;
          this.log(`⚡ Circuit breaker RESET for ${PROVIDER_DEFINITIONS[provider.provider].name}`);
        }

        if (stats.isHealthy) {
          this.currentProviderIndex = index;
          return provider;
        }
      }
    }

    // All providers unhealthy - use first one anyway
    this.log(`⚠️ All providers unhealthy, using first provider`);
    return this.providers[0];
  }

  private switchToNextProvider(): void {
    if (this.providers.length <= 1) return;

    const previousIndex = this.currentProviderIndex;
    this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
    this.rotateSession();

    const prevName = PROVIDER_DEFINITIONS[this.providers[previousIndex].provider].name;
    const newName = PROVIDER_DEFINITIONS[this.providers[this.currentProviderIndex].provider].name;
    this.log(`Switched from ${prevName} to ${newName}`);
  }

  private maybeRotateSession(): void {
    if (this.requestsInCurrentSession >= this.config.sessionRotationRequests) {
      this.rotateSession();
    }
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[ProxyManager] ${message}`);
    }
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a ProxyManager configured from environment variables
 */
export function createProxyManager(config?: Partial<ProxyManagerConfig>): ProxyManager {
  const manager = new ProxyManager(config);
  manager.configureFromEnv();
  return manager;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { PROVIDER_DEFINITIONS };
