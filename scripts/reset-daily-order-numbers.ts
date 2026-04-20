import mongoose from "mongoose";
import { DateTime } from "luxon";
import { connectDB } from "../src/lib/mongodb";
import Order from "../src/models/Order";
import { getAppTimezone, startOfBusinessDay, endOfBusinessDay } from "../src/lib/appTimezone";

const SequenceCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    date: { type: String, default: null },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: "sequence_counters" }
);

const SequenceCounter = mongoose.models.SequenceCounter || mongoose.model("SequenceCounter", SequenceCounterSchema);

function formatDateCode(date: Date): string {
  return DateTime.fromJSDate(date, { zone: getAppTimezone() }).toFormat("yyLLdd");
}

async function main() {
  await connectDB();

  const arg = process.argv[2];
  const tz = getAppTimezone();
  const targetDate = arg
    ? DateTime.fromISO(arg, { zone: tz }).isValid
      ? DateTime.fromISO(arg, { zone: tz }).toJSDate()
      : new Date(arg)
    : new Date();

  const dayStart = startOfBusinessDay(targetDate);
  const dayEnd = endOfBusinessDay(targetDate);
  const dateCode = formatDateCode(dayStart);
  const counterId = `ORD-${dateCode}`;

  const orders = await Order.find({
    createdAt: { $gte: dayStart, $lte: dayEnd },
  })
    .sort({ createdAt: 1 })
    .lean();

  if (!orders.length) {
    console.log(`No orders found for business date ${dateCode}`);
    await mongoose.disconnect();
    return;
  }

  console.log(`Renumbering ${orders.length} order(s) for business date ${dateCode}`);

  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const newNumber = `ORD-${dateCode}-${String(index + 1).padStart(2, "0")}`;
    if (order.orderNumber === newNumber) continue;
    await Order.updateOne({ _id: order._id }, { orderNumber: newNumber });
    console.log(`  ${order.orderNumber} -> ${newNumber}`);
  }

  await SequenceCounter.findOneAndUpdate(
    { _id: counterId },
    { _id: counterId, date: dateCode, seq: orders.length },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`Sequence counter ${counterId} reset to ${orders.length}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
