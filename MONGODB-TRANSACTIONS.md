# MongoDB transactions (recipe inventory + billing)

Billing ties together **invoice creation**, **order completion**, **inventory deductions**, and **consumption ledger** writes in a **single MongoDB transaction**. That requires the deployment to use a **replica set** (not a standalone `mongod` without replication).

- **MongoDB Atlas**: replica set is default; no extra setup.
- **Local development**: start MongoDB as a single-node replica set, for example:
  - `mongod --replSet rs0 --port 27017 --dbpath ...`
  - In `mongosh`: `rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })`

If you see `503` responses with a message about transactions and replica sets, enable a replica set for your `MONGODB_URI` target.
