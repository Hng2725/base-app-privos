import { PayrollRecord, IPayrollService } from '../types';
import { McpApp } from '@privos_ai/app-react';

export class PayrollService implements IPayrollService {
  private readonly app: McpApp;
  private readonly roomId: string;
  private readonly collectionName = 'payroll_records';

  constructor(app: McpApp, roomId: string) {
    if (!app) throw new Error("PayrollService requires a valid McpApp instance.");
    if (!roomId) throw new Error("PayrollService requires a roomId.");
    
    this.app = app;
    this.roomId = roomId;
  }

  async initializeSchema(): Promise<void> {
    try {
      // scope: db:schema:write — register the payroll collection once per room.
      // Reading it back (scope: db:schema:read) is what makes the failure below
      // recoverable: an already-registered collection is not an error.
      await this.app.callServerTool({
        name: 'privos.db.registerCollection',
        arguments: {
          collection: this.collectionName,
          fields: [
            { name: 'employeeId', type: 'string', required: true },
            { name: 'baseSalary', type: 'number', required: true },
            { name: 'taxId', type: 'string' },
            { name: 'bankAccount', type: 'string' },
            { name: 'roomId', type: 'string', required: true }
          ]
        }
      });
    } catch (err) {
      console.warn("Could not register schema, might already exist or not supported.", err);
    }
  }

  async getRecords(): Promise<PayrollRecord[]> {
    try {
      // scope: db:read — read this room's payroll records.
      const res: any = await this.app.callServerTool({
        name: 'hrm.payroll.query',
        // `roomId` is transport metadata for the backend passthrough: it names the
        // room the Hub resolves this app's grant against. The backend strips it
        // before forwarding to `privos.db.query`.
        arguments: {
          roomId: this.roomId,
          collection: this.collectionName,
          where: [{ field: 'roomId', op: '==', value: this.roomId }]
        }
      });
      const parsed = typeof res?.content?.[0]?.text === 'string' 
        ? JSON.parse(res.content[0].text) 
        : { records: [] };
      return parsed.records || [];
    } catch (err) {
      console.error("Failed to fetch payroll records:", err);
      throw err;
    }
  }

  /** scope: db:write — create or update one payroll record (and delete, below). */
  async saveRecord(record: PayrollRecord): Promise<void> {
    const { _id, _createdAt, _updatedAt, ...rest } = record as any;
    const data = { ...rest, roomId: this.roomId };
    
    if (record._id) {
      await this.app.callServerTool({
        name: 'hrm.payroll.update',
        arguments: { roomId: this.roomId, collection: this.collectionName, id: record._id, data }
      });
    } else {
      await this.app.callServerTool({
        name: 'hrm.payroll.create',
        arguments: { roomId: this.roomId, collection: this.collectionName, data }
      });
    }
  }

  async deleteRecord(id: string): Promise<void> {
    await this.app.callServerTool({
      name: 'hrm.payroll.delete',
      arguments: { roomId: this.roomId, collection: this.collectionName, id }
    });
  }
}
