/**
 * Dev utility: verifies the configured MongoDB is reachable, is a replica set,
 * and supports multi-document transactions. Touches ONLY a scratch collection
 * in the guarded database and drops it afterwards.
 *
 *   npx tsx src/scripts/db-smoke.ts
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db.js';

await connectDb();
const db = mongoose.connection.db;
if (!db) throw new Error('no db handle');
console.log('connected to database:', db.databaseName);

const hello = await db.admin().command({ hello: 1 });
console.log('replica set:', hello.setName ?? 'NONE (standalone — transactions will fail)');
console.log('is primary:', hello.isWritablePrimary);

const scratch = db.collection('_txn-smoke');

// 1. Aborted transaction must leave nothing behind.
let session = await mongoose.startSession();
session.startTransaction();
await scratch.insertOne({ probe: 'abort-me' }, { session });
await session.abortTransaction();
await session.endSession();
const afterAbort = await scratch.countDocuments({ probe: 'abort-me' });
console.log('after abort, docs found:', afterAbort, afterAbort === 0 ? 'OK' : 'FAIL');

// 2. Committed transaction must persist.
session = await mongoose.startSession();
session.startTransaction();
await scratch.insertOne({ probe: 'commit-me' }, { session });
await session.commitTransaction();
await session.endSession();
const afterCommit = await scratch.countDocuments({ probe: 'commit-me' });
console.log('after commit, docs found:', afterCommit, afterCommit === 1 ? 'OK' : 'FAIL');

await scratch.drop();
console.log('scratch collection dropped');
await disconnectDb();
