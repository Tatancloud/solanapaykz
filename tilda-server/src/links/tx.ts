// tilda-server/src/links/tx.ts
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner,
  createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction,
} from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { resolveToken } from '@solanapaykz/core';
import type { Token } from './db.js';

export interface PayTxParams {
  cluster: 'mainnet' | 'devnet';
  token: Token;
  buyer: string;
  merchant: string;
  feeWallet: string;
  merchantUnits: bigint;
  feeUnits: bigint;
  reference: string;
  memo: string;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
}

function withReference(ix: Instruction, reference: string): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), { address: address(reference), role: AccountRole.READONLY }] };
}

export async function buildPaymentTransaction(p: PayTxParams): Promise<string> {
  const buyer = createNoopSigner(address(p.buyer));
  const transfers: Instruction[] = [];

  if (p.token === 'SOL') {
    transfers.push(getTransferSolInstruction({ source: buyer, destination: address(p.merchant), amount: p.merchantUnits }));
    if (p.feeUnits > 0n) {
      transfers.push(getTransferSolInstruction({ source: buyer, destination: address(p.feeWallet), amount: p.feeUnits }));
    }
  } else {
    const { mint, decimals } = resolveToken(p.cluster, 'USDC');
    const mintAddress = address(mint!);
    const ata = async (owner: string) =>
      (await findAssociatedTokenPda({ owner: address(owner), mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    const source = await ata(p.buyer);
    transfers.push(getTransferCheckedInstruction({ source, mint: mintAddress, destination: await ata(p.merchant),
      authority: buyer, amount: p.merchantUnits, decimals }));
    if (p.feeUnits > 0n) {
      transfers.push(getTransferCheckedInstruction({ source, mint: mintAddress, destination: await ata(p.feeWallet),
        authority: buyer, amount: p.feeUnits, decimals }));
    }
  }

  transfers[0] = withReference(transfers[0]!, p.reference);
  const instructions = [...transfers, getAddMemoInstruction({ memo: p.memo })];

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(buyer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: p.blockhash.blockhash as Blockhash, lastValidBlockHeight: p.blockhash.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
