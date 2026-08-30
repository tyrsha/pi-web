import { resolveAppUrl, type AppUrlContext } from "./appUrl";

/** Structural view of the service-worker registration API this module drives. */
export interface ServiceWorkerContainerLike {
  register(url: string): Promise<unknown>;
}

/** Minimal structural view of the navigator surface this module uses. */
export interface PwaNavigatorLike {
  readonly serviceWorker?: ServiceWorkerContainerLike | undefined;
}

/** Minimal structural view of the window APIs registration scheduling touches. */
export interface PwaWindowLike {
  addEventListener(type: "load", listener: () => void): void;
  readonly document?: { readonly readyState: string } | undefined;
}

export interface RegisterPwaServiceWorkerOptions {
  /** Browser `navigator`, injected for testing. Defaults to the global when present. */
  readonly navigatorObject?: PwaNavigatorLike | undefined;
  /** Browser `window`, injected for testing. Registration runs immediately when absent or already loaded. */
  readonly windowObject?: PwaWindowLike | undefined;
  /** Absolute URL of the worker script. Defaults to resolving `sw.js` against the application base (requires a browser document). */
  readonly url?: string | undefined;
}

/**
 * Resolve the browser-ready absolute URL of the PI WEB service worker. The path stays
 * application-relative so nested reverse-proxy deployments keep their scope within the prefix.
 * Like {@link resolveAppUrl}, omitting the context reads browser globals, so tests should inject one.
 */
export function resolveServiceWorkerUrl(context?: AppUrlContext): string {
  return context === undefined ? resolveAppUrl("sw.js") : resolveAppUrl("sw.js", context);
}

/**
 * Register the PI WEB service worker once the page has finished loading.
 *
 * Best-effort by contract: an unavailable ServiceWorkerContainer (insecure contexts, unsupported
 * browsers) is skipped silently, and a failed registration is logged without ever breaking the app —
 * PI WEB must keep working with no service worker at all.
 */
export function registerPwaServiceWorker(options: RegisterPwaServiceWorkerOptions = {}): void {
  const navigatorObject = options.navigatorObject ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (navigatorObject?.serviceWorker === undefined) return;
  const container = navigatorObject.serviceWorker;
  const windowObject = options.windowObject;
  const url = options.url ?? resolveServiceWorkerUrl();

  const register = () => {
    void container.register(url).catch((error: unknown) => {
      console.debug("PI WEB service worker registration failed", error);
    });
  };

  if (windowObject === undefined || windowObject.document?.readyState === "complete") {
    register();
    return;
  }
  windowObject.addEventListener("load", register);
}
