const express = require("express");
const bodyParser = require("body-parser");
const {
  Op: { ne },
} = require("sequelize");

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
      .send("Only a client is allowed to initiate a payment");

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
    return res.status(404).send("The job was not found or was already paid");

  if (req.profile.balance < contractWithJobToBePaid.Jobs[0].price)
    return res
      .status(400)
      .send("There are no sufficient funds to process the payment");

  const t = await sequelize.transaction();

  try {
    await Profile.increment(["balance"], {
      by: -contractWithJobToBePaid.Jobs[0].price,
      where: {
        id: contractWithJobToBePaid.ClientId,
      },
      transaction: t,
    });

    await Profile.increment(["balance"], {
      by: contractWithJobToBePaid.Jobs[0].price,
      where: {
        id: contractWithJobToBePaid.ContractorId,
      },
      transaction: t,
    });

    await Contract.update(
      { status: "terminated" },
      {
        where: {
          id: contractWithJobToBePaid.id,
        },
        transaction: t,
      }
    );

    await Job.update(
      { paid: true, paymentDate: new Date() },
      { where: { id: req.params.job_id }, transaction: t }
    );

    await t.commit();

    res.send("The job was successfully paid");
  } catch (error) {
    console.log({ error });

    await t.rollback();

    res.status(500).send("An error has occured. Please try again!");
  }
});

module.exports = app;
