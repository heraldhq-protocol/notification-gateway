import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

try {
  const notifications = await prisma.notification.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log('=== NOTIFICATIONS ===');
  for (const n of notifications) {
    console.log(`${n.id.slice(0,8)}... | status: ${n.status} | arweave: ${n.arweaveId?.slice(0,16)??'none'} | receiptTx: ${n.receiptTx?.slice(0,16)??'none'} | createdAt: ${n.createdAt}`);
  }

  const deliveries = await prisma.channelDelivery.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { notification: { select: { id: true, status: true } } },
  });

  console.log('\n=== CHANNEL DELIVERIES ===');
  for (const d of deliveries) {
    console.log(`${d.id.slice(0,8)}... | notification: ${d.notificationId.slice(0,8)}... | channel: ${d.channel} | status: ${d.status} | deliveredAt: ${d.deliveredAt ?? 'null'}`);
  }

  const receipts = await prisma.sandboxReceipt.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  console.log(`\n=== SANDBOX RECEIPTS (${receipts.length}) ===`);
  for (const r of receipts) {
    console.log(`${r.id.slice(0,8)}... | tx: ${r.transactionSignature?.slice(0,16)??'none'} | tree: ${r.merkleTreePubkey?.slice(0,16)??'none'}`);
  }
} finally {
  await prisma.$disconnect();
}
