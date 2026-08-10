import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function resolveRepoAlias(specifier) {
  const basePath = path.join(repoRoot, specifier.slice(2));
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];

  return candidates.find((candidate) => {
    if (!existsSync(candidate)) {
      return false;
    }

    return statSync(candidate).isFile();
  });
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      shortCircuit: true,
      url: "data:text/javascript,export {};",
    };
  }

  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }

  if (specifier === "next/navigation") {
    return nextResolve("next/navigation.js", context);
  }

  if (specifier === "next/cache") {
    return nextResolve("next/cache.js", context);
  }

  if (specifier.startsWith("@/")) {
    const resolvedPath = resolveRepoAlias(specifier);

    if (!resolvedPath) {
      throw new Error("Test loader could not resolve a repository alias.");
    }

    return nextResolve(pathToFileURL(resolvedPath).href, context);
  }

  return nextResolve(specifier, context);
}
