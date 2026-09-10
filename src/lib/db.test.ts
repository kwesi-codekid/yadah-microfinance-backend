import { describe, expect, it } from 'vitest';
import { databaseNameFromUri } from './db.js';

describe('databaseNameFromUri', () => {
  it('reads the database from a single-host uri', () => {
    expect(databaseNameFromUri('mongodb://127.0.0.1:27017/yadah-test')).toBe('yadah-test');
  });

  it('reads the database from a replica-set uri with several hosts', () => {
    // Commas in the host list make this uri unparseable by `new URL()`.
    expect(
      databaseNameFromUri(
        'mongodb://root:secret@a1:27017,b2:27017,c3:27017/yadah-dynamic?replicaSet=rs1&authSource=admin',
      ),
    ).toBe('yadah-dynamic');
  });

  it('reads the database from an srv uri', () => {
    expect(databaseNameFromUri('mongodb+srv://user:pw@cluster.example.net/yadah-staging?w=1')).toBe(
      'yadah-staging',
    );
  });

  it('is not fooled by percent-encoded credentials', () => {
    expect(databaseNameFromUri('mongodb://user:p%40ss%2Fword@host:27017/yadah-dev')).toBe(
      'yadah-dev',
    );
  });

  it('decodes a percent-encoded database name', () => {
    expect(databaseNameFromUri('mongodb://host:27017/yadah%20dev')).toBe('yadah dev');
  });

  it('returns empty when no database is named', () => {
    expect(databaseNameFromUri('mongodb://a:27017,b:27017')).toBe('');
    expect(databaseNameFromUri('mongodb://a:27017,b:27017/')).toBe('');
    expect(databaseNameFromUri('mongodb://a:27017/?replicaSet=rs1')).toBe('');
  });

  it('rejects a uri that is not a mongo connection string', () => {
    expect(() => databaseNameFromUri('postgres://host/db')).toThrow(/mongodb:\/\//);
  });
});
