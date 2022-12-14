const express = require("express");
const bodyParser = require("body-parser");
const {
  Op: { ne, between },
} = require("sequelize");

const isValidDate = (date) => (isNaN(Date.parse(date)) ? false : true);

const { sequelize } = require("./model");

const { getProfile } = require("./middleware/getProfile");

const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({
    where: { id, ClientId: req.profile.id },
  });
  if (!contract) return res.status(404).end();
  res.json(contract);
});

app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");

  const queryFieldName =
    req.profile.type === "client" ? "ClientId" : "ContractorId";

  const contractList = await Contract.findAll({
    where: {
      [queryFieldName]: req.profile.id,
      status: { [ne]: "terminated" },
    },
  });

  res.json(contractList);
});

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Contract, Job } = req.app.get("models");

  const queryFieldName =
    req.profile.type === "client" ? "ClientId" : "ContractorId";

  // currently SQLite doesn't currently support right joins
  // so the contractList has to be fetched and then
  // map the jobList out from each contract
  const contractWithUnpaidJobList = await Contract.findAll({
    where: {
      [queryFieldName]: req.profile.id,
      status: "in_progress",
    },
    include: [
      {
        model: Job,
        where: {
          paid: false,
        },
      },
    ],
  });

  const unpaidJobList = contractWithUnpaidJobList.map(
    (contract) => contract.Jobs
  );
  // as the .map above will return an array of arrays they have to be flattened
  res.json(unpaidJobList.flat());
});

app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { Profile, Contract, Job } = req.app.get("models");

  if (req.profile.type !== "client")
    return res
      .status(403)
      .json({ message: "Only a client is allowed to initiate a payment" });

  const contractWithJobToBePaid = await Contract.findOne({
    where: {
      ClientId: req.profile.id,
      status: "in_progress",
    },
    include: [
      {
        model: Job,
        where: {
          id: req.params.job_id,
          paid: false,
        },
      },
    ],
  });

  if (!contractWithJobToBePaid)
    return res
      .status(404)
      .json({ message: "The job was not found or was already paid" });

  if (req.profile.balance < contractWithJobToBePaid.Jobs[0].price)
    return res.status(400).json({
      message: "There are no sufficient funds to process the payment",
    });

  const t = await sequelize.transaction();

  try {
    const updateClientPromise = Profile.increment(["balance"], {
      by: -contractWithJobToBePaid.Jobs[0].price,
      where: {
        id: contractWithJobToBePaid.ClientId,
      },
      transaction: t,
    });

    const updateContractorPromise = Profile.increment(["balance"], {
      by: contractWithJobToBePaid.Jobs[0].price,
      where: {
        id: contractWithJobToBePaid.ContractorId,
      },
      transaction: t,
    });

    const updateContractPromise = Contract.update(
      { status: "terminated" },
      {
        where: {
          id: contractWithJobToBePaid.id,
        },
        transaction: t,
      }
    );

    const updateJobPromise = Job.update(
      { paid: true, paymentDate: new Date() },
      { where: { id: req.params.job_id }, transaction: t }
    );

    await Promise.all([
      updateClientPromise,
      updateContractorPromise,
      updateContractPromise,
      updateJobPromise,
    ]);

    await t.commit();

    res.json({ message: "The job was successfully paid" });
  } catch (error) {
    console.log({ error });

    await t.rollback();

    res
      .status(500)
      .json({ message: "An error has occured. Please try again!" });
  }
});

app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  const { Profile, Contract, Job } = req.app.get("models");

  if (req.profile.id.toString() !== req.params.userId)
    return res
      .status(403)
      .json({ message: "A client cannot deposit money for another user" });

  if (req.profile.type !== "client")
    return res
      .status(403)
      .json({ message: "Only a client is allowed to deposit money" });

  const contractWithJobListToBePaid = await Contract.findAll({
    where: {
      ClientId: req.profile.id,
      status: "in_progress",
    },
    include: [
      {
        model: Job,
        where: {
          paid: false,
        },
      },
    ],
  });

  if (!contractWithJobListToBePaid?.length)
    return res.status(400).json({
      message: "There are no ongoing contracts so no deposit can be made",
    });

  const totalAmountToBePaid = contractWithJobListToBePaid
    .map((contract) => contract.Jobs)
    .flat()
    .reduce((acc, job) => {
      return (acc += job.price);
    }, 0);

  console.log("Total amount to be paid:", totalAmountToBePaid);

  if (req.body.amount > totalAmountToBePaid / 4)
    return res.status(400).json({
      message:
        "A client can't deposit more than 25% of his total of jobs to pay",
    });

  await Profile.increment(["balance"], {
    by: req.body.amount,
    where: {
      id: req.params.userId,
    },
  });

  res.json({ message: `$${req.body.amount} were successfully deposited.` });
});

app.get("/admin/best-profession", async (req, res) => {
  const { Profile, Contract, Job } = req.app.get("models");

  const { start: startDate, end: endDate } = req.query;

  if (!isValidDate(startDate)) {
    return res
      .status(400)
      .json({ message: "The provided `startDate` is invalid" });
  }

  if (!isValidDate(endDate)) {
    return res
      .status(400)
      .json({ message: "The provided `endDate` is invalid" });
  }

  const [bestPaidProfession] = await Job.findAll({
    raw: true,
    attributes: [
      "Contract.Contractor.profession",
      [sequelize.fn("SUM", sequelize.col("price")), "totalEarned"],
    ],
    where: {
      paymentDate: { [between]: [new Date(startDate), new Date(endDate)] },
    },
    include: [
      {
        model: Contract,
        where: { status: "terminated" },
        attributes: [],
        include: { model: Profile, as: "Contractor", attributes: [] },
      },
    ],
    group: ["Contract.ContractorId"],
    order: [["totalEarned", "DESC"]],
    limit: 1,
  });

  return res.json(
    bestPaidProfession || {
      message: "There is no paid job in the selected interval",
    }
  );
});

app.get("/admin/best-clients", async (req, res) => {
  const { Profile, Contract, Job } = req.app.get("models");

  const { start: startDate, end: endDate, limit } = req.query;

  if (!isValidDate(startDate))
    return res
      .status(400)
      .json({ message: "The provided `startDate` is invalid" });

  if (!isValidDate(endDate))
    return res
      .status(400)
      .json({ message: "The provided `endDate` is invalid" });

  if (limit && (isNaN(parseInt(limit)) || limit < 1))
    return res.status(400).json({ message: "The provided `limit` is invalid" });

  const bestPayingClientList = await Job.findAll({
    raw: true,
    attributes: [
      "Contract.Client.id",
      [sequelize.literal("firstName || ' ' || lastName"), "fullName"],
      [sequelize.fn("SUM", sequelize.col("price")), "paid"],
    ],
    where: {
      paymentDate: { [between]: [new Date(startDate), new Date(endDate)] },
    },
    include: [
      {
        model: Contract,
        where: { status: "terminated" },
        attributes: [],
        include: { model: Profile, as: "Client", attributes: [] },
      },
    ],
    group: ["Contract.ClientId"],
    order: [["paid", "DESC"]],
    limit: limit || 2,
  });

  res.json(
    bestPayingClientList?.length
      ? bestPayingClientList
      : {
          message: "There is no paid job in the selected interval",
        }
  );
});

module.exports = app;
