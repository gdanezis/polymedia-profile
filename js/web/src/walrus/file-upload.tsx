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
		registerBlob,
		writeToUploadRelay,
		certifyBlob,
		reset: resetUpload,
	} = useWalrusUpload();

	// Derive convenient flags from the state
	const uploadStatus = state.status;
	const isEncoding = uploadStatus === "encoding";
	const canRegister = uploadStatus === "can-register";
	const isRegistering = uploadStatus === "registering";
	const canRelay = uploadStatus === "can-relay";
	const isRelaying = uploadStatus === "relaying";
	const canCertify = uploadStatus === "can-certify";
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

	const handleRegisterBlob = async () => {
		await registerBlob({
			epochs,
			deletable: DELETABLE,
		});
	};

	const handleWriteToUploadRelay = async () => {
		await writeToUploadRelay();
	};

	const handleCertifyBlob = async () => {
		const result = await certifyBlob();

		// Transform the result to match the expected UploadResult interface
		onUploadComplete({
			patchId: result[0].id,
			blobId: result[0].blobId,
			suiObjectId: result[0].blobObject.id.id,
			endEpoch: result[0].blobObject.storage.end_epoch,
		});
		resetUploadProcess();
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

			if (!needsSui && !needsWal) {
				setFundAndDoAllStep("Local address already has sufficient funds!");
				setTimeout(() => {
					setFundAndDoAllStep("");
					setIsFundingAndDoingAll(false);
				}, 2000);
				return;
			}

			// Step 1: Fund the local address (only if needed)
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

			if (!hasFundingOperations) {
				setFundAndDoAllStep("No funding operations needed!");
				setTimeout(() => {
					setFundAndDoAllStep("");
					setIsFundingAndDoingAll(false);
				}, 2000);
				return;
			}

			// Execute funding transaction with wallet
			const result = await signAndExecuteTransaction({
				transaction: fundingTx,
			});

			console.log("Funding transaction completed:", result);
			setFundAndDoAllStep("Funding completed successfully!");
			
			// For now, just stop here and show success
			setTimeout(() => {
				setFundAndDoAllStep("");
				setIsFundingAndDoingAll(false);
			}, 2000);

		} catch (error) {
			console.error("Funding failed:", error);
			setError(error instanceof Error ? error.message : "Funding failed");
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
	const registerDisabled =
		!canRegister || isRegistering || !file || !currentAccount || isEncoding;
	const relayDisabled = !canRelay || isRelaying;
	const certifyDisabled = !canCertify || isCertifying;
	const hasRegistered = ["can-relay", "relaying", "can-certify", "certifying"].includes(
		uploadStatus,
	);
	const hasRelayed = ["can-certify", "certifying"].includes(uploadStatus);

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
				<h3>Upload Steps</h3>

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
						<span>💰 Fund local address</span>
					)}
				</button>

				{/* Step 1: Register Blob */}
				<button
					className={registerDisabled || hasRegistered ? "disabled" : ""}
					onClick={handleRegisterBlob}
					disabled={registerDisabled}
				>
					{isRegistering ? (
						<div className="button-loading">
							<Spinner />
							<span>Registering...</span>
						</div>
					) : hasRegistered ? (
						<span>✓ 1. Register Blob</span>
					) : !currentAccount ? (
						<span>1. Connect Wallet First</span>
					) : (
						<span>1. Register Blob</span>
					)}
				</button>

				{/* Step 2: Write to Upload Relay */}
				<button
					className={relayDisabled || hasRelayed ? "disabled" : ""}
					onClick={handleWriteToUploadRelay}
					disabled={relayDisabled}
				>
					{isRelaying ? (
						<div className="button-loading">
							<Spinner />
							<span>Uploading to Walrus...</span>
						</div>
					) : hasRelayed ? (
						<span>✓ 2. Uploaded to Walrus</span>
					) : (
						<span>2. Upload to Walrus</span>
					)}
				</button>

				{/* Step 3: Certify Blob */}
				<button
					className={certifyDisabled ? "disabled" : ""}
					onClick={handleCertifyBlob}
					disabled={certifyDisabled}
				>
					{isCertifying ? (
						<div className="button-loading">
							<Spinner />
							<span>Certifying...</span>
						</div>
					) : (
						<span>3. Certify Upload</span>
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
