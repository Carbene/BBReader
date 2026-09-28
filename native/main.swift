import Foundation
import CryptoKit

struct Failure: Error, CustomStringConvertible { let description: String; init(_ s:String){description=s} }
let fm = FileManager.default
var selfTestMode=false
var home = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/BBReader", isDirectory:true)
struct Config: Codable { var root: String?; var courses: [String:String] = [:] }
func config() throws -> Config {
    let path = home.appendingPathComponent("config.json")
    if !fm.fileExists(atPath:path.path) { return Config() }
    return try JSONDecoder().decode(Config.self, from:Data(contentsOf:path))
}
func save(_ c:Config) throws {
    try fm.createDirectory(at:home,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    try JSONEncoder().encode(c).write(to:home.appendingPathComponent("config.json"),options:.atomic)
    try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:home.appendingPathComponent("config.json").path)
}
func migrationJournalURL(_ id:String) throws -> URL {
    guard UUID(uuidString:id) != nil else {throw Failure("无效迁移凭证")}
    let folder=home.appendingPathComponent("migrations",isDirectory:true)
    try fm.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    return folder.appendingPathComponent("\(id).json")
}
func string(_ d:[String:Any],_ k:String) throws -> String {
    guard let s=d[k] as? String, !s.isEmpty else {throw Failure("缺少字段：\(k)")};return s
}
func validCourse(_ s:String) -> Bool {s.range(of:"^_[0-9]+_[0-9]+$",options:.regularExpression) != nil}
func components(_ raw:Any?) throws -> [String] {
    guard let a=raw as? [String], !a.isEmpty, a.count<=24 else {throw Failure("无效的相对路径")}
    for p in a {
        guard !p.isEmpty,p != ".",p != "..",p.utf8.count<=240,!p.contains("/"),!p.contains("\\"),!p.contains(":"),
            !p.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}) else {throw Failure("拒绝不安全的路径")}
    };return a
}
func safeTarget(_ root:String,_ parts:[String]) throws -> URL {
    let base=URL(fileURLWithPath:root,isDirectory:true).standardizedFileURL.resolvingSymlinksInPath()
    guard fm.fileExists(atPath:base.path) else {throw Failure("归档目录不存在，请重新选择")}
    var out=base
    for p in parts {
        out.appendPathComponent(p)
        if out.resolvingSymlinksInPath().standardizedFileURL.path != out.standardizedFileURL.path {throw Failure("拒绝经过符号链接归档")}
    }
    guard out.path.hasPrefix(base.path+"/") else {throw Failure("目标路径越界")};return out
}
func sha(_ u:URL) throws -> String {
    let f=try FileHandle(forReadingFrom:u);defer{try? f.close()}
    var hash=SHA256()
    while let chunk=try f.read(upToCount:1024*1024),!chunk.isEmpty { hash.update(data:chunk) }
    return hash.finalize().map{String(format:"%02x",$0)}.joined()
}
// Remove BBReader-staging/<token> (and BBReader-staging itself) once they are empty, so Downloads keeps no cache folders.
func cleanStaging(_ source:URL, removeFile:Bool=false) {
    if removeFile {try? fm.removeItem(at:source)}
    let tokenFolder=source.deletingLastPathComponent(),staging=tokenFolder.deletingLastPathComponent()
    guard staging.lastPathComponent=="BBReader-staging" else {return}
    func empty(_ u:URL) -> Bool {(try? fm.contentsOfDirectory(atPath:u.path).filter{$0 != ".DS_Store"}.isEmpty)==true}
    if empty(tokenFolder) {try? fm.removeItem(at:tokenFolder)}
    if empty(staging) {try? fm.removeItem(at:staging)}
}
// Default archive root: <package>/course-files next to the installed extension, as in 0.2.5. Never replaces a chosen root.
func ensureDefaultRoot(_ package:URL) throws -> String {
    var c=try config()
    if let root=c.root, !root.isEmpty {return root}
    let target=package.appendingPathComponent("course-files",isDirectory:true).standardizedFileURL
    try fm.createDirectory(at:target,withIntermediateDirectories:true)
    c.root=target.resolvingSymlinksInPath().path;try save(c);return c.root!
}
func rootAndParts(_ msg:[String:Any],_ c:Config) throws -> (String,[String]) {
    let course=try string(msg,"courseId");guard validCourse(course) else {throw Failure("无效课程 ID")}
    let parts=try components(msg["relative"])
    guard let root=c.courses[course] ?? c.root else {throw Failure("请先选择归档目录")}
    // Course overrides are already the course directory, so omit term/course prefixes.
    return (root,c.courses[course] == nil ? parts : Array(parts.dropFirst(min(2,parts.count-1))))
}
func handle(_ msg:[String:Any]) throws -> [String:Any] {
    let op=try string(msg,"op");var c=try config()
    if op=="status" {return ["ok":true,"version":"0.4.0","root":c.root ?? "","courses":c.courses,"capabilities":["confirmed-directory-migration","saved-path-validation","migration-journal"]]}
    if ["saveCredentials","deleteCredentials","credentialStatus","readCredentials"].contains(op) {return try handleAuth(msg)}
    if op=="connectReminders" || op=="syncReminders" {return try handleReminders(msg)}
    if op=="migrationJournal" {
        let path=try migrationJournalURL(string(msg,"planId")),action=try string(msg,"action")
        if action=="save" {
            guard let record=msg["record"] as? [String:Any],JSONSerialization.isValidJSONObject(record) else {throw Failure("迁移记录格式无效")}
            try JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]).write(to:path,options:.atomic);try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)
            return ["ok":true,"saved":true]
        }
        if action=="finish" {try? fm.removeItem(at:path);return ["ok":true,"removed":true]}
        throw Failure("未知迁移日志操作")
    }
    if op=="discardStaging" {
        let token=try string(msg,"token");guard UUID(uuidString:token) != nil else {throw Failure("无效下载凭证")}
        let source=URL(fileURLWithPath:try string(msg,"source")).standardizedFileURL,path=source.pathComponents
        guard path.count>=4,path[path.count-3]=="BBReader-staging",path[path.count-2]==token,source.resolvingSymlinksInPath().standardizedFileURL.path==source.path else {throw Failure("拒绝清理非当前任务的暂存文件")}
        cleanStaging(source,removeFile:true);return ["ok":true,"discarded":true]
    }
    if op=="setRoot" || op=="setCourse" {
        let path=try string(msg,"path")
        guard path.hasPrefix("/") else {throw Failure("请输入绝对文件夹路径")}
        let url=URL(fileURLWithPath:path,isDirectory:true).standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory:ObjCBool=false
        guard (selfTestMode || url.path.hasPrefix(fm.homeDirectoryForCurrentUser.path+"/")),fm.fileExists(atPath:url.path,isDirectory:&isDirectory),isDirectory.boolValue else {throw Failure("请选择用户目录下已经存在的文件夹")}
        if op=="setRoot" {c.root=url.path} else {let course=try string(msg,"courseId");guard validCourse(course) else {throw Failure("无效课程 ID")};c.courses[course]=url.path}
        try save(c);return ["ok":true,"root":c.root ?? "","courses":c.courses]
    }
    if op=="existsPath" {
        let path=URL(fileURLWithPath:try string(msg,"path")).standardizedFileURL
        guard (selfTestMode || path.path.hasPrefix(fm.homeDirectoryForCurrentUser.path+"/")),path.resolvingSymlinksInPath().standardizedFileURL.path==path.path else {throw Failure("拒绝检查未授权的文件路径")}
        var dir:ObjCBool=false;return ["ok":true,"exists":fm.fileExists(atPath:path.path,isDirectory:&dir) && !dir.boolValue]
    }
    let (configuredRoot,configuredParts)=try rootAndParts(msg,c)
    let root:String,parts:[String]
    if op=="relocate",let targetRoot=msg["destinationRoot"] as? String {
        let url=URL(fileURLWithPath:targetRoot,isDirectory:true).standardizedFileURL.resolvingSymlinksInPath();var isDirectory:ObjCBool=false
        guard (selfTestMode || url.path.hasPrefix(fm.homeDirectoryForCurrentUser.path+"/")),fm.fileExists(atPath:url.path,isDirectory:&isDirectory),isDirectory.boolValue else {throw Failure("迁移目标必须是用户目录下已存在的文件夹")}
        root=url.path;parts=try components(msg["targetRelative"] ?? msg["relative"])
    } else {root=configuredRoot;parts=configuredParts}
    let destination=try safeTarget(root,parts)
    if op=="exists" {return ["ok":true,"exists":fm.fileExists(atPath:destination.path)]}
    guard op=="archive" || op=="relocate" else {throw Failure("未知操作")}
    let relocating=op=="relocate"
    let source:URL
    if relocating {
        if let raw=msg["sourcePath"] as? String {
            source=URL(fileURLWithPath:raw).standardizedFileURL
            guard source.path.hasPrefix(fm.homeDirectoryForCurrentUser.path+"/"),source.resolvingSymlinksInPath().standardizedFileURL.path==source.path else {throw Failure("拒绝迁移未授权的源路径")}
        } else {
            let (sourceRoot,sourceParts)=try rootAndParts(["courseId":msg["courseId"]!,"relative":msg["sourceRelative"] as Any],c)
            source=try safeTarget(sourceRoot,sourceParts)
        }
        let expected=try string(msg,"sha256")
        guard expected.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else {throw Failure("缺少有效文件校验值")}
        guard fm.fileExists(atPath:source.path) else {
            if fm.fileExists(atPath:destination.path),try sha(destination)==expected{return ["ok":true,"moved":true,"path":destination.path,"relative":msg["relative"]!,"sha256":expected,"unchanged":true]}
            return ["ok":true,"moved":false]
        }
        var sourceDirectory:ObjCBool=false
        guard fm.fileExists(atPath:source.path,isDirectory:&sourceDirectory),!sourceDirectory.boolValue else {throw Failure("迁移源不是普通文件")}
        guard try sha(source)==expected else {return ["ok":true,"moved":false,"preserved":true]}
        if source==destination {return ["ok":true,"moved":true,"path":source.path,"relative":msg["relative"]!,"sha256":expected]}
    } else {
        let token=try string(msg,"token");guard UUID(uuidString:token) != nil else {throw Failure("无效下载凭证")}
        source=URL(fileURLWithPath:try string(msg,"source")).standardizedFileURL
        let pathParts=source.pathComponents
        guard pathParts.count>=4,pathParts[pathParts.count-3]=="BBReader-staging",pathParts[pathParts.count-2]==token,
              source.resolvingSymlinksInPath().path==source.path else {throw Failure("源文件不是 BBReader 的受控暂存文件")}
    }
    defer {if !relocating && !fm.fileExists(atPath:source.path) {cleanStaging(source)}}
    defer {
        if relocating && !fm.fileExists(atPath:source.path) {
            let base=URL(fileURLWithPath:root,isDirectory:true).standardizedFileURL.resolvingSymlinksInPath()
            var folder=source.deletingLastPathComponent()
            while folder.path.hasPrefix(base.path+"/"),(try? fm.contentsOfDirectory(atPath:folder.path).isEmpty)==true {
                do {try fm.removeItem(at:folder)} catch {break}
                folder.deleteLastPathComponent()
            }
        }
    }
    let values=try source.resourceValues(forKeys:[.isRegularFileKey,.fileSizeKey])
    guard values.isRegularFile==true,(values.fileSize ?? 0)>0 else {if !relocating {cleanStaging(source,removeFile:true)};throw Failure("下载为空或不是普通文件")}
    let stream=try FileHandle(forReadingFrom:source)
    let head=try stream.read(upToCount:1024) ?? Data();try stream.close()
    let prefix=String(decoding:head,as:UTF8.self).trimmingCharacters(in:.whitespacesAndNewlines).lowercased()
    if prefix.hasPrefix("<!doctype html") || prefix.hasPrefix("<html") {if !relocating {cleanStaging(source,removeFile:true)};throw Failure("收到 HTML 页面，可能是登录已过期；未归档")}
    if source.pathExtension.lowercased()=="pdf" && !head.starts(with:Data("%PDF-".utf8)) {if !relocating {cleanStaging(source,removeFile:true)};throw Failure("下载内容不是有效 PDF 文件头")}
    let checksum=try sha(source)
    var target=destination,actual=parts
    if fm.fileExists(atPath:target.path) {
        if try sha(target)==checksum {try fm.removeItem(at:source);return ["ok":true,"path":target.path,"relative":msg["relative"]!,"sha256":checksum,"unchanged":true,"moved":relocating]}
        let ext=target.pathExtension,stem=target.deletingPathExtension().lastPathComponent
        let name="\(stem) [\(checksum.prefix(12))]" + (ext.isEmpty ? "" : ".\(ext)")
        actual[actual.count-1]=name;target=try safeTarget(root,actual)
        if fm.fileExists(atPath:target.path) {
            guard try sha(target)==checksum else {throw Failure("目标版本冲突，保留暂存文件")}
        }
    }
    if relocating && target==source {
        var full=try components(msg["relative"]);full[full.count-1]=actual.last!
        return ["ok":true,"moved":true,"path":source.path,"relative":full,"sha256":checksum]
    }
    if !fm.fileExists(atPath:target.path) {
        try fm.createDirectory(at:target.deletingLastPathComponent(),withIntermediateDirectories:true)
        _ = try safeTarget(root,actual)
        let temporary=target.deletingLastPathComponent().appendingPathComponent(".bbreader-\(UUID().uuidString).part")
        defer{try? fm.removeItem(at:temporary)}
        try fm.copyItem(at:source,to:temporary)
        guard try sha(temporary)==checksum else {throw Failure("文件复制校验失败")}
        try fm.moveItem(at:temporary,to:target) // Fails safely if another writer created the target.
    }
    try fm.removeItem(at:source)
    var full=try components(msg["relative"]);full[full.count-1]=actual.last!
    return ["ok":true,"path":target.path,"relative":full,"sha256":checksum,"moved":relocating]
}
func readExact(_ n:Int) throws -> Data? {
    var data=Data()
    while data.count<n {
        guard let next=try FileHandle.standardInput.read(upToCount:n-data.count),!next.isEmpty else {
            if data.isEmpty{return nil};throw Failure("消息不完整")
        };data.append(next)
    };return data
}
func send(_ value:[String:Any]) throws {
    let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);var count=UInt32(data.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes:&count,count:4));FileHandle.standardOutput.write(data)
}
func require(_ condition:Bool) { if !condition { fatalError("Native self-test failed") } }
func selfTest() throws {
    selfTestMode=true
    let temp=fm.temporaryDirectory.appendingPathComponent("bbreader-test-\(UUID().uuidString)")
    defer{try? fm.removeItem(at:temp)}
    home=temp.appendingPathComponent("config")
    let root=temp.appendingPathComponent("output");try fm.createDirectory(at:root,withIntermediateDirectories:true)
    try save(Config(root:root.path))
    let token=UUID().uuidString,stage=temp.appendingPathComponent("BBReader-staging/\(token)/lecture.pdf")
    func stageData(_ text:String) throws {try fm.createDirectory(at:stage.deletingLastPathComponent(),withIntermediateDirectories:true);try Data(text.utf8).write(to:stage)}
    try stageData("%PDF-1.4\nfixture-one")
    let msg:[String:Any]=["op":"archive","source":stage.path,"token":token,"courseId":"_1_1","relative":["term","course","lecture.pdf"]]
    let first=try handle(msg);require(fm.fileExists(atPath:first["path"] as! String));require(!fm.fileExists(atPath:stage.path))
    require(!fm.fileExists(atPath:temp.appendingPathComponent("BBReader-staging").path)) // staging cache removed
    try stageData("%PDF-1.4\nfixture-two")
    let second=try handle(msg);require(first["path"] as! String != second["path"] as! String)
    try stageData("%PDF-1.4\nfixture-two")
    let third=try handle(msg);require(third["path"] as! String == second["path"] as! String)
    do {_ = try components(["..","escape"]);throw Failure("path traversal accepted")}catch let e as Failure {require(e.description != "path traversal accepted")}
    try fm.createSymbolicLink(at:root.appendingPathComponent("link"),withDestinationURL:temp)
    do {_ = try safeTarget(root.path,["link","escape"]);throw Failure("symlink accepted")}catch let e as Failure {require(e.description != "symlink accepted")}
    try stageData("<html>login</html>")
    do {_ = try handle(msg);throw Failure("login accepted")}catch let e as Failure {require(e.description != "login accepted")}
    require(!fm.fileExists(atPath:stage.deletingLastPathComponent().path)) // rejected login page is discarded
    let cancelledToken=UUID().uuidString,cancelledStage=temp.appendingPathComponent("BBReader-staging/\(cancelledToken)/partial.pdf")
    try fm.createDirectory(at:cancelledStage.deletingLastPathComponent(),withIntermediateDirectories:true);try Data("partial download".utf8).write(to:cancelledStage)
    let discarded=try handle(["op":"discardStaging","token":cancelledToken,"source":cancelledStage.path]);require(discarded["discarded"] as? Bool == true);require(!fm.fileExists(atPath:cancelledStage.path))
    let old=first["path"] as! String
    let move:[String:Any]=["op":"relocate","courseId":"_1_1","sourceRelative":["term","course","lecture.pdf"],"relative":["term","course","Lab 1","lecture.pdf"],"sha256":first["sha256"]!]
    let relocated=try handle(move);require(relocated["moved"] as? Bool == true);require(!fm.fileExists(atPath:old));require(fm.fileExists(atPath:relocated["path"] as! String))
    let repeated=try handle(move);require(repeated["moved"] as? Bool == true)
    var back=move;back["sourceRelative"]=relocated["relative"];back["relative"]=["term","course","lecture.pdf"]
    _ = try handle(back);require(!fm.fileExists(atPath:root.appendingPathComponent("term/course/Lab 1").path))
    try Data("%PDF-1.4\nuser edit".utf8).write(to:URL(fileURLWithPath:old))
    let edited=try handle(move);require(edited["preserved"] as? Bool == true);require(fm.fileExists(atPath:old))
    var version=move;version["sourceRelative"]=second["relative"];version["relative"]=["term","course","lecture.pdf"];version["sha256"]=second["sha256"]
    let versioned=try handle(version);require(versioned["path"] as? String == second["path"] as? String);require(fm.fileExists(atPath:versioned["path"] as! String))
    let migrationRoot=temp.appendingPathComponent("migration-\(UUID().uuidString)")
    try fm.createDirectory(at:migrationRoot,withIntermediateDirectories:true);defer{try? fm.removeItem(at:migrationRoot)}
    let migration:[String:Any]=["op":"relocate","courseId":"_1_1","sourceRelative":second["relative"]!,"relative":second["relative"]!,"destinationRoot":migrationRoot.path,"targetRelative":["lecture.pdf"],"sha256":second["sha256"]!]
    let migrated=try handle(migration);require(migrated["moved"] as? Bool == true);require(fm.fileExists(atPath:migrated["path"] as! String));require(!fm.fileExists(atPath:second["path"] as! String))
    let exists=try handle(["op":"existsPath","path":migrated["path"]!]);require(exists["exists"] as? Bool == true)
    let journalID=UUID().uuidString,journal:[String:Any]=["id":journalID,"files":[["path":migrated["path"]!]]]
    _ = try handle(["op":"migrationJournal","action":"save","planId":journalID,"record":journal]);require(fm.fileExists(atPath:try migrationJournalURL(journalID).path))
    _ = try handle(["op":"migrationJournal","action":"finish","planId":journalID]);require(!fm.fileExists(atPath:try migrationJournalURL(journalID).path))
    var unsafe=move;unsafe["sourceRelative"]=["..","escape"]
    do {_ = try handle(unsafe);throw Failure("unsafe relocation accepted")}catch let e as Failure {require(e.description != "unsafe relocation accepted")}
    // Default root is created beside the package only when no root has been chosen.
    let chosen=try config().root ?? ""
    let kept=try ensureDefaultRoot(temp.appendingPathComponent("package"));require(kept==chosen)
    try save(Config());let fallback=try ensureDefaultRoot(temp.appendingPathComponent("package"))
    require(fallback.hasSuffix("/package/course-files") && fm.fileExists(atPath:fallback))
    try save(Config(root:chosen))
    try remindersSelfTest()
    print("Native tests passed: staging cleanup, default root, archive, versions, deduplication, traversal, symlinks, login response, confirmed cross-directory relocation, saved-path validation, edited file preservation.")
}
func install() throws {
    let executable=URL(fileURLWithPath:CommandLine.arguments[0]).standardizedFileURL
    let originFile=executable.deletingLastPathComponent().appendingPathComponent("extension-origin.txt")
    let origin=try String(contentsOf:originFile,encoding:.utf8).trimmingCharacters(in:.whitespacesAndNewlines)
    guard origin.range(of:"^chrome-extension://[a-p]{32}/$",options:.regularExpression) != nil else {throw Failure("扩展标识无效")}
    try fm.createDirectory(at:home,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    let bundle=home.appendingPathComponent("BBReader Helper.app/Contents")
    let macOS=bundle.appendingPathComponent("MacOS")
    try fm.createDirectory(at:macOS,withIntermediateDirectories:true)
    let info:[String:Any]=["CFBundleIdentifier":"cn.sustech.bbreader.helper","CFBundleName":"BBReader Helper","CFBundleExecutable":"bbreader-host","CFBundlePackageType":"APPL","CFBundleVersion":"2","NSRemindersFullAccessUsageDescription":"将 Blackboard 作业同步到专属列表，并保留你勾选的完成状态。仅操作 BBReader 创建的提醒事项。","NSRemindersUsageDescription":"同步 Blackboard 作业截止时间，并保留完成状态。","LSUIElement":true,"NSHighResolutionCapable":true]
    try PropertyListSerialization.data(fromPropertyList:info,format:.xml,options:0).write(to:bundle.appendingPathComponent("Info.plist"),options:.atomic)
    let installed=macOS.appendingPathComponent("bbreader-host")
    try Data(contentsOf:executable).write(to:installed,options:.atomic)
    try fm.setAttributes([.posixPermissions:0o700],ofItemAtPath:installed.path)
    try Data(origin.utf8).write(to:macOS.appendingPathComponent("extension-origin.txt"),options:.atomic)
    let dir=fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts")
    try fm.createDirectory(at:dir,withIntermediateDirectories:true)
    let manifest:[String:Any]=["name":"cn.sustech.bbreader","description":"BBReader local course archive","path":installed.path,"type":"stdio","allowed_origins":[origin]]
    try JSONSerialization.data(withJSONObject:manifest,options:[.prettyPrinted,.sortedKeys]).write(to:dir.appendingPathComponent("cn.sustech.bbreader.json"),options:.atomic)
    let package=URL(fileURLWithPath:executable.path).resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
    let root=try ensureDefaultRoot(package)
    print("本地助手已安装。课件默认归档到：\(root)\n可在 BBReader「连接与设置」中更改。请在 Chrome 加载 extension 文件夹。")
}
do {
    if CommandLine.arguments.contains("--self-test") {try selfTest()}
    else if CommandLine.arguments.contains("--install") {try install()}
    else {
        let expected=Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("extension-origin.txt")
        let origin=try String(contentsOf:expected,encoding:.utf8).trimmingCharacters(in:.whitespacesAndNewlines)
        guard CommandLine.arguments.dropFirst().contains(origin) else {throw Failure("不允许的扩展来源")}
        while let header=try readExact(4) {
            let size=header.withUnsafeBytes{Int(UInt32(littleEndian:$0.loadUnaligned(as:UInt32.self)))}
            guard size>0,size<=1024*1024,let payload=try readExact(size) else {throw Failure("消息长度错误")}
            do {
                guard let message=try JSONSerialization.jsonObject(with:payload) as? [String:Any] else {throw Failure("消息格式错误")}
                try send(handle(message))
            } catch {try send(["ok":false,"error":String(describing:error)])}
        }
    }
} catch {FileHandle.standardError.write(Data("BBReader: \(error)\n".utf8));exit(1)}
