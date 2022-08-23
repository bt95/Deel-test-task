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

module.exports = app;
