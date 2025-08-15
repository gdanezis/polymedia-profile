import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useEffect, useRef, useState } from "react";
import { useAppContext } from "../app/context";
import { Spinner } from "../comp/spinner";
import { useWalrusUpload } from "./useWalrusUpload";

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MiB in bytes
const DELETABLE = true; // always allow blobs to be deleted
const MAX_EPOCHS = 53;
const MAINNET_EPOCH_DAYS = 14;
const TESTNET_EPOCH_DAYS = 1;

export interface UploadResult {
	patchId: string;
	blobId: string;
	suiObjectId: string;
	endEpoch: number;
}

interface FileUploadProps {
	onUploadComplete: (uploadedBlob: UploadResult) => void;
	onUploadProgressChange?: (hasProgress: boolean) => void;
}

export default function FileUpload({
	onUploadComplete,
	onUploadProgressChange,
}: FileUploadProps) {
	const currentAccount = useCurrentAccount();
	const suiClient = useSuiClient();
	const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction();
	const { network, keypair } = useAppContext();

	// UI state
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [epochs, setEpochs] = useState(1);
	const [error, setError] = useState<string | null>(null);

	// Fund and do all state
	const [isFundingAndDoingAll, setIsFundingAndDoingAll] = useState(false);
	const [fundAndDoAllStep, setFundAndDoAllStep] = useState("");

	// Use the new Walrus upload hook
	const {
		state,
		encodeFile,
		reset: resetUpload,
	} = useWalrusUpload();

	// Derive convenient flags from the state
	const uploadStatus = state.status;
	const isEncoding = uploadStatus === "encoding";
	const isRegistering = uploadStatus === "registering";
	const isRelaying = uploadStatus === "relaying";
	const isCertifying = uploadStatus === "certifying";
	const uploadError = uploadStatus === "error" ? state.message : null;

	// Check if there's upload progress that would be lost
	const hasUploadProgress = !!(
		file &&
		uploadStatus !== "idle" &&
		uploadStatus !== "error"
	);

	// Notify parent about progress changes
	useEffect(() => {
		onUploadProgressChange?.(hasUploadProgress);
	}, [hasUploadProgress, onUploadProgressChange]);

	const handleFileSelect = async (selectedFile: File) => {
		if (isEncoding) {
			return;
		}

		setError(null);

		if (selectedFile.size > MAX_FILE_SIZE) {
			const fileSizeMiB = (selectedFile.size / (1024 * 1024)).toFixed(2);
			const maxSizeMiB = MAX_FILE_SIZE / (1024 * 1024);
			setError(
				`File size (${fileSizeMiB} MiB) exceeds maximum allowed size (${maxSizeMiB} MiB)`,
			);
			setFile(null);
			return;
		}

		resetUpload();

		setFile(selectedFile);

		document.body.classList.add("cursor-wait");
		try {
			await encodeFile(selectedFile);
		} finally {
			document.body.classList.remove("cursor-wait");
		}
	};

	const handleFundAndDoAll = async () => {
		console.log("handleFundAndDoAll called!");
		console.log("currentAccount:", currentAccount);
		console.log("file:", file);
		console.log("isFundingAndDoingAll:", isFundingAndDoingAll);
		
		if (!currentAccount || !file) {
			console.log("Early return: missing currentAccount or file");
			return;
		}

		setIsFundingAndDoingAll(true);
		try {
			const localAddress = keypair.getPublicKey().toSuiAddress();
			console.log("Local address:", localAddress);

			// Check current balances of local address
			setFundAndDoAllStep("Checking local address balances...");
			
			const [suiCoins, walCoins] = await Promise.all([
				suiClient.getCoins({
					owner: localAddress,
					coinType: "0x2::sui::SUI"
				}),
				suiClient.getCoins({
					owner: localAddress,
					coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL"
				}).catch(() => ({ data: [] })) // Handle case where address has no WAL coins
			]);

			const currentSuiBalance = suiCoins.data.reduce((total, coin) => total + Number(coin.balance), 0);
			const currentWalBalance = walCoins.data.reduce((total, coin) => total + Number(coin.balance), 0);
			
			const requiredSui = 100_000_000; // 0.1 SUI in MIST
			const requiredWal = 1_000_000_000; // 1 WAL
			
			const needsSui = currentSuiBalance < requiredSui;
			const needsWal = currentWalBalance < requiredWal;
			
			console.log("Balance check:", {
				currentSuiBalance,
				currentWalBalance,
				needsSui,
				needsWal
			});

			// Step 1: Fund the local address if needed
			if (needsSui || needsWal) {
				setFundAndDoAllStep("Funding local address...");
				
				const fundingTx = new Transaction();
				let hasFundingOperations = false;
				
				// Transfer SUI if needed
				if (needsSui) {
					const [suiCoin] = fundingTx.splitCoins(fundingTx.gas, [requiredSui]);
					fundingTx.transferObjects([suiCoin], localAddress);
					hasFundingOperations = true;
					console.log("Adding SUI transfer to transaction");
				}

				// Transfer WAL if needed and available
				if (needsWal) {
					try {
						const userWalCoins = await suiClient.getCoins({
							owner: currentAccount.address,
							coinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL"
						});

						if (userWalCoins.data.length > 0) {
							// Use the first WAL coin found
							const walCoin = userWalCoins.data[0];
							if (Number(walCoin.balance) >= requiredWal) {
								const [walTransferCoin] = fundingTx.splitCoins(fundingTx.object(walCoin.coinObjectId), [requiredWal]);
								fundingTx.transferObjects([walTransferCoin], localAddress);
								hasFundingOperations = true;
								console.log("Adding WAL transfer to transaction");
							}
						}
					} catch (walError) {
						console.warn("Failed to transfer WAL coin:", walError);
						// Continue without WAL - SUI should be enough for the operations
					}
				}

				if (hasFundingOperations) {
					// Execute funding transaction with wallet
					const result = await signAndExecuteTransaction({
						transaction: fundingTx,
					});
					console.log("Funding transaction completed:", result);
					
					// Wait for funding transaction to settle before using the funded coins
					console.log("Waiting for funding transaction to settle...");
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}

			// Step 2: Ensure file is encoded (if not already)
			setFundAndDoAllStep("Preparing file for upload...");
			if (state.status === "idle") {
				await encodeFile(file);
			}

			// Wait for encoding to complete
			if (state.status !== "can-register") {
				throw new Error("File encoding failed or not ready for registration");
			}

			// Step 3: Create local signing function
			const localSignTx = async (tx: Transaction) => {
				tx.setSender(localAddress);
				const { bytes, signature } = await keypair.signTransaction(await tx.build({ client: suiClient }));
				return suiClient.executeTransactionBlock({
					transactionBlock: bytes,
					signature,
					options: {
						showEffects: true,
						showEvents: true,
						showObjectChanges: true,
					},
				});
			};

			// Step 4: Register blob using local keypair
			setFundAndDoAllStep("Registering blob with local keypair...");
			
			if (state.status !== "can-register") {
				throw new Error("Not ready for registration");
			}

			const registerTx = state.writeFileFlow.register({
				epochs,
				deletable: DELETABLE,
				owner: localAddress,
			});

			const registerResult = await localSignTx(registerTx);
			
			if (registerResult.effects?.status.status !== "success") {
				throw new Error(`Register failed: ${registerResult.effects?.status.error}`);
			}

			console.log("Registration completed:", registerResult.digest);

			// Step 5: Upload to Walrus
			setFundAndDoAllStep("Uploading blob to Walrus...");
			await state.writeFileFlow.upload({
				digest: registerResult.digest,
			});

			console.log("Upload to Walrus completed");

			// Step 6: Certify blob using local keypair
			setFundAndDoAllStep("Certifying blob with local keypair...");
			
			const certifyTx = state.writeFileFlow.certify();
			const certifyResult = await localSignTx(certifyTx);
			
			if (certifyResult.effects?.status.status !== "success") {
				throw new Error(`Certify failed: ${certifyResult.effects?.status.error}`);
			}

			console.log("Certification completed:", certifyResult.digest);

			// Step 7: Transfer remaining coins back to user
			setFundAndDoAllStep("Transferring remaining coins back...");
			
			// Wait a moment for the blockchain state to settle after the previous transaction
			await new Promise(resolve => setTimeout(resolve, 1000));
			
			// Get ALL coins on the local address (not just SUI and WAL)
			const allCoins = await suiClient.getAllCoins({
				owner: localAddress,
			});

			console.log("All coins on local address:", allCoins.data.map(c => ({ 
				id: c.coinObjectId, 
				type: c.coinType, 
				version: c.version, 
				balance: c.balance 
			})));

			// Transfer back ALL coins
			if (allCoins.data.length > 0) {
				const returnTx = new Transaction();
				let hasReturnOperations = false;

				// Find SUI coins and use the largest as gas
				const suiCoins = allCoins.data.filter(c => c.coinType === "0x2::sui::SUI");
				const nonSuiCoins = allCoins.data.filter(c => c.coinType !== "0x2::sui::SUI");

				if (suiCoins.length > 0) {
					// Sort SUI coins by balance (largest first) to use the largest as gas
					const sortedSuiCoins = [...suiCoins].sort((a, b) => Number(b.balance) - Number(a.balance));
					const gasCoin = sortedSuiCoins[0];
					const gasBalance = Number(gasCoin.balance);
					
					console.log("Using gas coin:", { id: gasCoin.coinObjectId, version: gasCoin.version, balance: gasBalance });
					
					// Set the largest SUI coin as gas payment
					returnTx.setGasPayment([{
						objectId: gasCoin.coinObjectId,
						version: gasCoin.version,
						digest: gasCoin.digest
					}]);

					// Return all other SUI coins (if any) - don't try to split the gas coin
					for (let i = 1; i < sortedSuiCoins.length; i++) {
						const coin = sortedSuiCoins[i];
						returnTx.transferObjects([returnTx.object(coin.coinObjectId)], currentAccount.address);
						hasReturnOperations = true;
						console.log("Adding other SUI coin return:", { id: coin.coinObjectId, type: coin.coinType, balance: coin.balance });
					}

					// Transfer the gas coin itself as a whole object (gas will be deducted automatically)
					if (sortedSuiCoins.length === 1) {
						// If this is the only SUI coin, transfer it as-is (gas will be deducted)
						returnTx.transferObjects([returnTx.gas], currentAccount.address);
						hasReturnOperations = true;
						console.log("Adding gas coin return (whole object):", gasBalance);
					}
				}

				// Return ALL non-SUI coins (WAL, and any other coin types)
				for (const coin of nonSuiCoins) {
					returnTx.transferObjects([returnTx.object(coin.coinObjectId)], currentAccount.address);
					hasReturnOperations = true;
					console.log("Adding coin return:", { id: coin.coinObjectId, type: coin.coinType, balance: coin.balance });
				}

				if (hasReturnOperations) {
					console.log("Executing return transaction...");
					const returnResult = await localSignTx(returnTx);
					console.log("Return transaction completed:", returnResult.digest);
				} else {
					console.log("No return operations needed");
				}
			} else {
				console.log("No coins found on local address to return");
			}

			// Step 8: Get final result and complete
			const files = await state.writeFileFlow.listFiles();
			
			// Transform the result to match the expected UploadResult interface
			onUploadComplete({
				patchId: files[0].id,
				blobId: files[0].blobId,
				suiObjectId: files[0].blobObject.id.id,
				endEpoch: files[0].blobObject.storage.end_epoch,
			});
			
			setFundAndDoAllStep("Upload completed successfully!");
			
			// Clean up and show success
			setTimeout(() => {
				resetUploadProcess();
				setFundAndDoAllStep("");
				setIsFundingAndDoingAll(false);
			}, 2000);

		} catch (error) {
			console.error("Fund and do all failed:", error);
			setError(error instanceof Error ? error.message : "Fund and do all failed");
			setIsFundingAndDoingAll(false);
			setFundAndDoAllStep("");
		}
	};

	const resetUploadProcess = () => {
		setFile(null);
		setError(null);
		resetUpload();
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const displayError = error || uploadError;
	const disableFileAndDuration =
		isRegistering || isRelaying || isCertifying || isEncoding;

	// Debug the button state
	const fundButtonDisabled = !file || isEncoding || !currentAccount || isFundingAndDoingAll;
	console.log("Fund button debug:", {
		file: !!file,
		isEncoding,
		currentAccount: !!currentAccount,
		isFundingAndDoingAll,
		disabled: fundButtonDisabled
	});

	return (
		<div className="walrus-form">
			<div className="form-field">
				<div className="walrus-file-upload-container">
					<input
						type="file"
						ref={fileInputRef}
						className="walrus-file-input"
						onChange={(e) => {
							const selectedFile = e.target.files?.[0];
							if (selectedFile) {
								handleFileSelect(selectedFile);
							}
						}}
						disabled={disableFileAndDuration}
					/>
					<div className="walrus-drop-zone">
						{file ? (
							<div>
								<div>
									{isEncoding ? "⏳" : "✅"} <b>{file.name}</b>
								</div>
								<p>{(file.size / (1024 * 1024)).toFixed(2)} MiB</p>
								{isEncoding ? (
									<button disabled>Processing...</button>
								) : (
									<button type="button" disabled={disableFileAndDuration}>
										CHOOSE FILE
									</button>
								)}
							</div>
						) : (
							<div>
								<p>Drag & drop a file</p>
								<p>Max {MAX_FILE_SIZE / (1024 * 1024)} MiB</p>
								<button type="button" disabled={disableFileAndDuration}>
									CHOOSE FILE
								</button>
							</div>
						)}
					</div>
				</div>
				{displayError && <div className="field-error">{displayError}</div>}
			</div>

			<div className="form-field">
				<h3>Storage Duration</h3>
				<input
					type="range"
					value={epochs}
					onChange={(e) => setEpochs(Math.max(1, Math.floor(Number(e.target.value))))}
					min="1"
					max={MAX_EPOCHS}
					step="1"
					disabled={disableFileAndDuration}
				/>
				<div className="field-info">
					{formatEpochDuration(
						epochs,
						network === "mainnet" ? MAINNET_EPOCH_DAYS : TESTNET_EPOCH_DAYS,
					)}
				</div>
			</div>

			{/* Upload Buttons */}
			<div className="btn-group">
				<h3>Upload</h3>

				{/* Fund and Do All Button */}
				<button
					className="fund-and-do-all-btn"
					onClick={handleFundAndDoAll}
					disabled={fundButtonDisabled}
				>
					{isFundingAndDoingAll ? (
						<div className="button-loading">
							<Spinner />
							<span>{fundAndDoAllStep}</span>
						</div>
					) : (
						<span>Upload</span>
					)}
				</button>
			</div>
		</div>
	);
}

const formatEpochDuration = (epochs: number, epochDurationDays: number) => {
	if (epochDurationDays % 7 === 0) {
		const weeks = Math.floor((epochs * epochDurationDays) / 7);
		const weekLabel = weeks === 1 ? "week" : "weeks";
		return `${weeks} ${weekLabel}`;
	}
	const dayLabel = epochs === 1 ? "day" : "days";
	return `${epochs} ${dayLabel}`;
};
