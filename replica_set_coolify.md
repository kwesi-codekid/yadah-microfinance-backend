3× One-Click MongoDB → Replica Set (Coolify UI)
Prep (same as before)

DNS A record: db.yourdomain.com → VPS IP.
Provider cloud firewall: allow TCP 27017-27019 from your IP only.
Keyfile — Coolify → Servers → Terminal (only non-UI moment, 30 seconds):

sudo mkdir -p /data/mongo-rs
sudo sh -c 'openssl rand -base64 756 > /data/mongo-rs/keyfile'
sudo chmod 400 /data/mongo-rs/keyfile && sudo chown 999:999 /data/mongo-rs/keyfile
Step 1 — Create database #1

- New Resource → Databases → MongoDB, then in its settings:

Name: mongo-1
Username / Password: yadah / your generated password — identical on all three
Make it publicly available: ✅, Public Port: 27017
Custom MongoDB Configuration — paste:

replication:
replSetName: rs0
security:
keyFile: /etc/mongo-keyfile
Persistent Storages → + Add: source /data/mongo-rs/keyfile → destination /etc/mongo-keyfile
Step 2 — Repeat for mongo-2 and mongo-3
Exactly the same, only the Public Port changes: 27018 and 27019. Deploy all three.

Step 3 — Found the replica set (once)
Open mongo-1 → Terminal in the Coolify UI:

mongosh -u yadah -p '<password>' --authenticationDatabase admin --eval "
rs.initiate({ _id: 'rs0', members: [
{ _id: 0, host: 'db.yourdomain.com:27017', priority: 2 },
{ _id: 1, host: 'db.yourdomain.com:27018', priority: 1 },
{ _id: 2, host: 'db.yourdomain.com:27019', priority: 1 } ]})"
mongo-2 and mongo-3 will wipe their own data and clone everything from mongo-1 (users included) — that's the "initial sync" and it's expected.

Step 4 — Verify from your dev machine

npx mongosh "mongodb://yadah:<password>@db.yourdomain.com:27017,db.yourdomain.com:27018,db.yourdomain.com:27019/?replicaSet=rs0&authSource=admin" --eval "rs.status().members.map(m => m.name + ' ' + m.stateStr)"
Want: one PRIMARY, two SECONDARY.

Step 5 — The URI

mongodb://yadah:<password>@db.yourdomain.com:27017,db.yourdomain.com:27018,db.yourdomain.com:27019/yadah?replicaSet=rs0&authSource=admin
Two honest warnings about this route vs. compose:

Field names vary by Coolify version. If you don't see "Custom MongoDB Configuration" or file-mount storage on a database resource, your version can't do it UI-only — the compose resource becomes the fallback.
Three separate resources = three things to keep in sync by hand (same password, same keyfile, same config). The compose version is one resource doing the same thing — it is a Coolify UI feature too, just with the config in one pasted block instead of spread across three forms.
One-click DBs won't set --wiredTigerCacheSizeGB, so if the VPS has under ~4 GB RAM, add storage: { wiredTiger: { engineConfig: { cacheSizeGB: 0.25 } } } to each custom config block.
Try Step 1 and tell me if your Coolify version shows those two fields — if yes, run it through Step 4 and give me the shout when you see PRIMARY/SECONDARY; I'll wire up .env and start on the Mongoose models.
