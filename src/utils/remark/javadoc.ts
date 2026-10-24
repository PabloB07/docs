import type { RemarkPlugin } from "@astrojs/markdown-remark";
import { deadOrAlive } from "dead-or-alive";
import { visit } from "unist-util-visit";

// Link checking is enabled in CI to avoid rate limiting during local development.
// Note `process.env.CI` can be the string "false" (e.g. when explicitly disabled),
// which would otherwise be truthy here.
const CI = Boolean(process.env.CI) && process.env.CI !== "false";

// replaces special Markdown links with Javadoc URLs
// link format: jd:<javadoc name>[:<module name>][:<fully qualified class name; . as package separator, $ for inner>]

interface Target {
  url: string;
  module?: string; // default
}

interface Options {
  targets: Record<string, string | Target>;
}

const asUrl = (name: string): string => {
  let [name0, hash] = name.split("#", 2);
  name0 = name0.replaceAll(".", "/").replaceAll("$", ".");
  if (hash) {
    hash = hash.replaceAll("$", ".");
  }

  return `${name0}.html` + (hash ? `#${hash}` : "");
};

const asRef = (name: string): string => {
  let [name0, hash] = name.split("#", 2);
  name0 = name0.replaceAll(".", "/");

  const lastSlash = name0.lastIndexOf("/");
  if (lastSlash !== -1) {
    // remove package
    name0 = name0.substring(lastSlash + 1);
  }
  name0 = name0.replaceAll("$", ".");

  const parenIndex = hash?.indexOf("(");
  if (hash && parenIndex !== -1) {
    // method parameters
    const params = hash.substring(parenIndex + 1, hash.length - 1).split(",");
    hash = `${hash.substring(0, parenIndex)}(${params.map((p) => p.substring(p.lastIndexOf(".") + 1)).join(", ")})`;
    hash = hash.replaceAll("$", ".");
  }

  return name0 + (hash ? `#${hash}` : "");
};

const error = (err: any): never => {
  if (process.env.NODE_ENV === "production") {
    console.error(err);

    // throwing an error does not exit the build process, it silently fails
    // we don't want missing pages, so exit the process instead
    process.exit(1);
  } else {
    throw err;
  }
};

interface ParseResult {
  url?: string;
  ref?: string;
}

// Keep the number of simultaneous requests to the external Javadoc sites low.
// Firing all checks at once gets them rate-limited or makes them time out, which
// `dead-or-alive` reports as a dead link.
const MAX_CONCURRENT_CHECKS = 6;

// `dead-or-alive` defaults (3s timeout, 1 retry) are too aggressive for a burst of checks.
const CHECK_TIMEOUT = 15_000;
const CHECK_RETRIES = 3;

const parse = async (url: string, { targets }: Options): Promise<ParseResult> => {
  const match = /^jd:(.+?)(?::(.+?))?(?::(.+?))?$/.exec(url);
  if (!match) {
    if (url.startsWith("jd:")) {
      error(new Error(`Failed to parse Javadoc link "${url}"`));
    }

    return {}; // not a Javadoc link
  }

  const target = targets[match[1]];
  if (!target) {
    error(new Error(`Unknown target for Javadoc link "${url}"`));
  }

  const targetUrl = typeof target !== "string" ? target.url : target;

  const name = match[3] ?? match[2];
  if (!name) {
    return { url: targetUrl };
  }

  const module = match[3] ? match[2] : typeof target !== "string" ? target.module : undefined;
  const parsed = `${targetUrl}/${module ? `${module}/` : ""}${asUrl(name)}`;

  if (CI) {
    // only check links in CI to avoid rate limiting during local development
    const result = await deadOrAlive(parsed, {
      findUrls: false,
      followMetaHttpEquiv: false,
      timeout: CHECK_TIMEOUT,
      maxRetries: CHECK_RETRIES,
      userAgent: "PaperMC/docs (https://docs.papermc.io)",
    });
    if (result.status !== "alive") {
      error(new Error(`Received dead status for Javadoc link "${url}"`));
    }
  }

  return { url: parsed, ref: asRef(name) };
};

const plugin: RemarkPlugin = (options: Options) => {
  // Cache checks per link so repeated links (e.g. shared between locales) only hit
  // the Javadoc sites once.
  const cache = new Map<string, Promise<ParseResult>>();
  let active = 0;
  const queue: Array<() => void> = [];

  // Run external checks with a bounded concurrency.
  const withLimit = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= MAX_CONCURRENT_CHECKS) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }

    try {
      return await task();
    } finally {
      // Hand the slot to the next queued check, or release it.
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };

  const parseCached = (url: string): Promise<ParseResult> => {
    let result = cache.get(url);
    if (!result) {
      result = withLimit(() => parse(url, options));
      cache.set(url, result);
    }

    return result;
  };

  return async (tree) => {
    const promises: Promise<void>[] = [];
    visit(tree, "link", (node) => {
      promises.push(
        parseCached(node.url).then(({ url, ref }) => {
          node.url = url ?? node.url;
          if (ref && node.children.length === 0) {
            node.children.push({ type: "inlineCode", value: ref });
          }
        })
      );
    });
    await Promise.all(promises);
  };
};

export default plugin;
