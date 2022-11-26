import { gpi, PackageData } from "gpi";
import { depValid } from "./depValid";
import type { Lockfile } from "./lockfile";
import { isWs, getWsWanted } from "./utils";
import { EdgeType, Node, WorkspaceJson } from "./node";

type EachCallback = (
  pkgName: string,
  version: string,
  node: Node
) => void | boolean;

export type FilterType = (
  name: string,
  wanted: string,
  type: EdgeType
) => boolean;

export interface ManagerOptions {
  lockfile: Lockfile;
  legacyPeerDeps: boolean;
  registry?: string;
  filter?: FilterType;
  customFetch?: typeof fetch;
}

export class Manager {
  public workspace: Record<string, Node> = Object.create(null);
  public packages: Record<string, Record<string, Node>> = Object.create(null);
  // { react: { '1.0.0': Node } }
  private manifests = new Map<string, PackageData | Promise<PackageData>>();

  constructor(public opts: ManagerOptions) {}

  get lockfile() {
    return this.opts.lockfile;
  }

  // For the generated nodes,
  // some of them may be replaced by the current node,
  // and the same one should be reused as much as possible
  private tryReplace(target: Node) {
    const nodes = this.packages[target.name];
    if (nodes) {
      for (const version in nodes) {
        const node = nodes[version];
        if (node !== target) {
          for (const edge of node.usedEdges) {
            if (this.satisfiedBy(target, edge.wanted, null, edge.accept)) {
              edge.node = target;
              target.usedEdges.add(edge);
              node.usedEdges.delete(edge);
            }
          }
        }
      }
    }
  }

  fetchManifest(name: string, wanted: string) {
    const spec = `${name}@${wanted}`;
    if (this.manifests.has(spec)) {
      return this.manifests.get(spec)!;
    } else {
      const { registry, customFetch } = this.opts;
      const p = gpi(name, wanted, { registry, customFetch }).then((mani) => {
        this.manifests.set(spec, mani);
        return mani;
      });
      this.manifests.set(spec, p);
      return p;
    }
  }

  get(name: string) {
    return this.workspace[name] || null;
  }

  each(callback: EachCallback) {
    let cbRes: any = true;
    for (const name in this.packages) {
      for (const version in this.packages[name]) {
        cbRes = callback(name, version, this.packages[name][version]);
        if (cbRes === false) break;
      }
      if (cbRes === false) break;
    }
  }

  hasError() {
    let e = false;
    this.each((_n, _v, node) => {
      if (node.hasError()) {
        e = true;
        return false;
      }
    });
    return e;
  }

  logError() {
    this.each((_n, _v, node) => node.logErrors());
  }

  // accept: '' => '*'
  satisfiedBy(node: Node, wanted: string, from: Node | null, accept?: string) {
    if (accept !== undefined) accept = accept || "*";
    return depValid(node, wanted, accept, from);
  }

  tryGetReusableNode(
    name: string,
    wanted: string,
    from: Node,
    accept?: string
  ) {
    if (isWs(wanted)) {
      wanted = getWsWanted(wanted);
      const node = this.workspace[name];
      if (node) {
        if (this.satisfiedBy(node, wanted, from, accept)) {
          return node;
        }
      }
    } else {
      const nodes = this.packages[name];
      if (nodes) {
        for (const version in nodes) {
          const node = nodes[version];
          if (this.satisfiedBy(node, wanted, from, accept)) {
            return node;
          }
        }
      }
    }
    return null;
  }

  setReusableNode(node: Node) {
    if (node.isWorkspace()) {
      this.workspace[node.name] = node;
    } else {
      if (!this.packages[node.name]) {
        this.packages[node.name] = Object.create(null);
      }
      this.tryReplace(node);
      this.packages[node.name][node.version] = node;
    }
  }

  async createNode(name: string, wanted: string) {
    let pkgJson;
    let resolved;
    let integrity;
    const lockInfo = this.lockfile.tryGetNodeManifest(name, wanted);

    if (lockInfo) {
      pkgJson = lockInfo;
      resolved = lockInfo.resolved;
      integrity = lockInfo.integrity;
    } else {
      pkgJson = await this.fetchManifest(name, wanted);
      resolved = (pkgJson as PackageData).dist.tarball;
      integrity = (pkgJson as PackageData).dist.integrity;
    }

    return new Node({
      pkgJson,
      resolved,
      integrity,
      manager: this,
      type: "package",
      legacyPeerDeps: this.opts.legacyPeerDeps,
    });
  }

  createWorkspaceNode(pkgJson: WorkspaceJson) {
    return new Node({
      integrity: "",
      manager: this,
      type: "workspace",
      resolved: pkgJson.resolved || "",
      legacyPeerDeps: this.opts.legacyPeerDeps,
      pkgJson: pkgJson as Required<WorkspaceJson>,
    });
  }
}
