// FILE: staged-peer-dependencies.ts
// Purpose: Detects staged packages whose non-optional peer dependencies are missing
//          from the packaged node_modules tree.
// Layer: Release/build helper

export interface StagedPackageManifest {
  name: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface UnsatisfiedPeer {
  from: string;
  peer: string;
}

export function findUnsatisfiedPeers(
  packages: StagedPackageManifest[],
  present: ReadonlySet<string>,
): UnsatisfiedPeer[] {
  const unsatisfied: UnsatisfiedPeer[] = [];
  for (const stagedPackage of packages) {
    for (const peer of Object.keys(stagedPackage.peerDependencies ?? {})) {
      if (stagedPackage.peerDependenciesMeta?.[peer]?.optional === true) {
        continue;
      }
      if (!present.has(peer)) {
        unsatisfied.push({ from: stagedPackage.name, peer });
      }
    }
  }
  return unsatisfied;
}
