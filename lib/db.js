'use strict';

/**
 * Simple JSON-backed store for listings, leads, views, admin sessions meta.
 * Atomic writes via temp + rename. Sufficient for single-process demo / small volume.
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const rename = promisify(fs.rename);
const mkdir = promisify(fs.mkdir);

const DEFAULT = { listings: [], leads: [], views: [], meta: { version: 1 } };

class JsonDb {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this._lock = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = { ...DEFAULT, ...JSON.parse(raw) };
    } catch {
      this.data = structuredClone(DEFAULT);
      await this._persist();
    }
  }

  async _persist() {
    const tmp = this.filePath + '.tmp';
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  /** Serialize mutations */
  async mutate(fn) {
    const run = this._lock.then(async () => {
      const result = await fn(this.data);
      await this._persist();
      return result;
    });
    this._lock = run.catch(() => {});
    return run;
  }

  // --- Listings ---
  listListings() {
    return [...this.data.listings].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getListing(id) {
    return this.data.listings.find((l) => l.id === id) || null;
  }

  async createListing(listing) {
    return this.mutate((d) => {
      d.listings.push(listing);
      return listing;
    });
  }

  async updateListing(id, patch) {
    return this.mutate((d) => {
      const i = d.listings.findIndex((l) => l.id === id);
      if (i < 0) return null;
      d.listings[i] = { ...d.listings[i], ...patch, updatedAt: Date.now() };
      return d.listings[i];
    });
  }

  async deleteListing(id) {
    return this.mutate((d) => {
      const before = d.listings.length;
      d.listings = d.listings.filter((l) => l.id !== id);
      return before !== d.listings.length;
    });
  }

  // --- Leads ---
  listLeads() {
    return [...this.data.leads].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getLead(id) {
    return this.data.leads.find((l) => l.id === id) || null;
  }

  async createLead(lead) {
    return this.mutate((d) => {
      d.leads.push(lead);
      return lead;
    });
  }

  // --- Views ---
  listViews() {
    return [...this.data.views].sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  async addView(view) {
    return this.mutate((d) => {
      d.views.push(view);
      // Cap at 10k rows
      if (d.views.length > 10000) d.views = d.views.slice(-8000);
      return view;
    });
  }
}

module.exports = { JsonDb };
