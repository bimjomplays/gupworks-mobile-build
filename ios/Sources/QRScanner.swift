import AVFoundation
import UIKit

/// The camera behind the pairing screen: a full-screen preview that sits under the (then transparent) web view, so
/// the web UI draws the look D overlay on top of the live picture. Reports every QR code it reads; nothing is
/// recorded or saved.
final class QRScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    enum StartResult { case running, denied, noCamera }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    let previewView = PreviewView()
    /// called on the main queue with the text of each QR code in view (repeats while the code stays in view)
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "app.gupworks.mobile.camera")
    private var configured = false
    private var device: AVCaptureDevice?

    override init() {
        super.init()
        previewView.previewLayer.session = session
        previewView.previewLayer.videoGravity = .resizeAspectFill
        previewView.backgroundColor = .black
        previewView.isHidden = true
    }

    func start(_ done: @escaping (StartResult) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            run(done)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.run(done) : done(.denied) }
            }
        default:
            done(.denied)
        }
    }

    func stop() {
        setTorch(false)
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    /// returns whether the torch is on afterwards
    @discardableResult
    func setTorch(_ on: Bool) -> Bool {
        guard let d = device, d.hasTorch, d.isTorchAvailable, (try? d.lockForConfiguration()) != nil else { return false }
        d.torchMode = on ? .on : .off
        d.unlockForConfiguration()
        return d.torchMode == .on
    }

    private func run(_ done: @escaping (StartResult) -> Void) {
        queue.async {
            if !self.configured, !self.configure() {
                return DispatchQueue.main.async { done(.noCamera) }
            }
            if !self.session.isRunning { self.session.startRunning() }
            DispatchQueue.main.async { done(.running) }
        }
    }

    /// on the camera queue
    private func configure() -> Bool {
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: cam) else { return false }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .high
        let output = AVCaptureMetadataOutput()
        guard session.canAddInput(input), session.canAddOutput(output) else { return false }
        session.addInput(input)
        session.addOutput(output)
        guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: .main)
        if cam.isFocusModeSupported(.continuousAutoFocus), (try? cam.lockForConfiguration()) != nil {
            cam.focusMode = .continuousAutoFocus
            if cam.isAutoFocusRangeRestrictionSupported { cam.autoFocusRangeRestriction = .near }
            cam.unlockForConfiguration()
        }
        device = cam
        configured = true
        return true
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        for case let code as AVMetadataMachineReadableCodeObject in metadataObjects where code.type == .qr {
            if let text = code.stringValue { onCode?(text) }
        }
    }
}
