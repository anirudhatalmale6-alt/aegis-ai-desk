// Google Calendar adapter.
// In production this uses the Google Workspace API (service account / OAuth) to
// read availability, detect conflicts, and book employee appointments. For the
// POC it runs against a local JSON calendar so the scheduling flow - conflict
// checking, booking, reminders - is fully demonstrable with no Google setup.
// The function signatures mirror the real Google Calendar client.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export class CalendarStore {
  constructor(path) {
    this.path = path;
    this.events = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }

  _persist() {
    writeFileSync(this.path, JSON.stringify(this.events, null, 2));
  }

  list(employee) {
    return this.events
      .filter(e => !employee || e.employee === employee)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  _overlaps(aStart, aEnd, bStart, bEnd) {
    return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
  }

  findConflicts(employee, start, end) {
    return this.events.filter(e =>
      e.employee === employee && this._overlaps(start, end, e.start, e.end));
  }

  book({ employee, title, start, end, requester }) {
    const conflicts = this.findConflicts(employee, start, end);
    if (conflicts.length) {
      return { ok: false, reason: 'conflict', conflicts };
    }
    const ev = {
      id: 'evt_' + (this.events.length + 1).toString().padStart(4, '0'),
      employee, title, start, end, requester,
      status: 'confirmed',
      reminder: '15m before (auto)',
    };
    this.events.push(ev);
    this._persist();
    return { ok: true, event: ev };
  }
}
