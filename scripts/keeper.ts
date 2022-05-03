import axios from "axios";
import * as dotenv from "dotenv";
import fs from "fs";
import * as starknet from "starknet";
import { ethers, utils } from "ethers";
import { assert } from "ts-essentials";
const { genKeyPair, getKeyPair, getStarkKey, sign, verify } = starknet.ec;
import type { KeyPair, Signature } from "starknet";
dotenv.config();

const MASK_250 = BigInt(2 ** 250 - 1);

function toUint(splitUint: object): bigint {
  const _a = Object.values(splitUint);
  return BigInt(`0x${_a[1].toString(16)}${_a[0].toString(16)}`);
}

export function toBytes32(a: string): string {
  return `0x${BigInt(a).toString(16).padStart(64, "0")}`;
}

export function getSelectorFromName(name: string) {
  return (
    BigInt(utils.keccak256(Buffer.from(name))) % MASK_250
  ).toString();
}

export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  assert(value, `Please provide ${key} in .env file`);

  return value;
}

export async function getL1ContractAt(name: string, address: string) {
  console.log(`Using existing contract: ${name} at: ${address}`);
  const compiledContract = JSON.parse(
    fs.readFileSync(`./abis/${name}.json`).toString("ascii")
  );
  const contractFactory = new ethers.ContractFactory(compiledContract.abi, compiledContract.bytecode);
  return   contractFactory.attach(address);
}

export async function getL2ContractAt(provider: any, name: string, address: string) {
  console.log(`Using existing contract: ${name} at: ${address}`);
  const compiledContract = JSON.parse(
    fs.readFileSync(`./abis/${name}.json`).toString("ascii")
  );
  const contractFactory = new starknet.ContractFactory(compiledContract, provider);
  return contractFactory.attach(address);
}

async function transaction(
  txHash: string,
  network: string
) {
  let server;
  if (network === "GOERLI") {
    server = "alpha4.starknet.io";
  } else if (network === "MAINNET") {
    server = "alpha-mainnet.starknet.io";
  } else if (network === "localhost") {
    server = "localhost:5000";
  } else {
    throw new Error(`Cannot query L2 on network ${network}`);
  }
  console.log(`Retrieving transaction ${txHash}`);
  try {
    const url = `https://${server}/feeder_gateway/get_transaction_receipt?transactionHash=${txHash}`;
    const response = await axios.get(url);
    return response.data;
  } catch (err) {
    throw new Error(`Failed getting transaction ${txHash}`);
  }
}

async function flush() {
    const NETWORK = getRequiredEnv("NETWORK").toUpperCase();
    const provider = new starknet.Provider({
        baseUrl: 'https://alpha4.starknet.io',
        feederGatewayUrl: 'feeder_gateway',
        gatewayUrl: 'gateway',
    })
    const l1WormholeGatewayAddress = getRequiredEnv(`${NETWORK}_L1_DAI_WORMHOLE_GATEWAY_ADDRESS`);
    const l2WormholeGatewayAddress = getRequiredEnv(`${NETWORK}_L2_DAI_WORMHOLE_GATEWAY_ADDRESS`);
    const l1WormholeGateway = await getL1ContractAt("L1DAIWormholeGateway", l1WormholeGatewayAddress);
    const l2WormholeGateway = await getL2ContractAt(provider, "l2_dai_wormhole_gateway", l2WormholeGatewayAddress);

    const accountAddress = getRequiredEnv(`${NETWORK}_L2_ACCOUNT_ADDRESS`);

    const ECDSA_PRIVATE_KEY =
      process.env[`${NETWORK}_ECDSA_PRIVATE_KEY`];
    if (!ECDSA_PRIVATE_KEY) {
      throw new Error(`Set ${NETWORK}_ECDSA_PRIVATE_KEY in .env`);
    }
    const starkKeyPair = starknet.ec.genKeyPair(ECDSA_PRIVATE_KEY);
    const starkKeyPub = starknet.ec.getStarkKey(starkKeyPair);;
    const account = new starknet.Account(provider, accountAddress, starkKeyPair);

    const domain = getRequiredEnv("DOMAIN");
    const { res: daiToFlushSplit } = await l2WormholeGateway.batched_dai_to_flush(domain);
    const daiToFlush = toUint(daiToFlushSplit);
    console.log(`DAI to flush: ${daiToFlush}`);

    if (daiToFlush > 0 || true) {
      console.log("Sending `flush` transaction");
      let { code, transaction_hash: txHash } = await l2WormholeGateway.flush(domain);

      console.log(`Waiting for transaction ${txHash} to be accepted on L1`);
      while (code !== "ACCEPTED_ON_L1") {
        code = (await transaction(txHash, NETWORK)).status;
      }

      console.log("Sending `finalizeFlush` transaction");
      await l1WormholeGateway.finalizeFlush(toBytes32(domain), daiToFlush);
    }
}

flush();
