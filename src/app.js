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

module.exports = app;
